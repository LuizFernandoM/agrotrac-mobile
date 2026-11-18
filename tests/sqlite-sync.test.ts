import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SyncCoordinator } from '../src/sync';
import { database, snapshot, response } from './support';
test('real file SQLite reopen recovers once, persists snapshot/backoff/settings; constraints guard immutable transitions', async () => {
  const first = database(), s = snapshot();
  await first.repo.initialize(); await first.repo.insert(s); await first.repo.setSetting('api_url','https://gateway.example.invalid');
  assert.equal(await first.repo.claim(s.payload.local_id),true);
  await first.repo.initialize(); assert.equal((await first.repo.list())[0].status,'IN_FLIGHT');
  first.db.close();
  const second = database(first.path);
  try {
    await second.repo.initialize(); const r = (await second.repo.list())[0];
    assert.equal(r.status,'PENDING'); assert.equal(r.attempts,1); assert.deepEqual(r.payload,s.payload); assert.deepEqual(r.photo,s.photo); assert.ok(readFileSync(s.photo.uri).length);
    assert.equal(await second.repo.setting('api_url'),'https://gateway.example.invalid');
    assert.throws(() => second.db.prepare("UPDATE weighings SET payload='{}'").run());
    assert.throws(() => second.db.prepare("UPDATE weighings SET status='SYNCED'").run());
    await second.repo.claim(s.payload.local_id); await second.repo.failure(s.payload.local_id,'HTTP_413',true,12345);
  } finally { second.db.close(); }
  const third = database(first.path);
  try { await third.repo.initialize(); const r=(await third.repo.list())[0]; assert.equal(r.auto_retry_blocked,1); assert.equal(r.next_attempt_at,12345); assert.equal(await third.repo.next(999999),undefined); }
  finally { third.db.close(); }
});
test('network, timeout, malformed body and divergent acknowledgement never synced; persisted backoff stops immediate loop', async t => {
  for (const mode of ['network','timeout','invalid','divergent','hash','size','mime','500']) await t.test(mode,async () => {
    const { repo,db }=database(), s=snapshot(); let calls=0;
    try {
      await repo.initialize(); await repo.insert(s);
      const sync=new SyncCoordinator(repo,async () => { calls++; if (mode==='network'||mode==='timeout') throw Error(mode); const b=response(s); return { status:mode==='500'?500:200,body:mode==='invalid'?null:mode==='divergent'?{...b,placa:'XYZ9A99'}:mode==='hash'?{...b,romaneio:{...b.romaneio,file_sha256:'a'.repeat(64)}}:mode==='size'?{...b,romaneio:{...b.romaneio,file_size_bytes:2}}:mode==='mime'?{...b,romaneio:{...b.romaneio,mime_type:'image/jpeg'}}:b }; },()=>{},()=>1000);
      await sync.trigger(); await sync.trigger(); const r=(await repo.list())[0]; assert.equal(r.status,'PENDING'); assert.equal(r.attempts,1); assert.equal(r.next_attempt_at,3000); assert.equal(calls,1);
    } finally {db.close();}
  });
});
test('409 conflict and permanent 400/403/413/415 never automatically loop on subsequent events',async t => {
  for (const status of [400,403,409,413,415]) await t.test(String(status), async()=> {
    const {repo,db}=database(),s=snapshot(); let calls=0,now=1;
    try { await repo.initialize();await repo.insert(s);const sync=new SyncCoordinator(repo,async()=>{calls++;return {status,body:null};},()=>{},()=>now);
      await sync.trigger();now=1e10;await sync.trigger();const r=(await repo.list())[0];assert.equal(r.status,status===409?'FAILED_CONFLICT':'PENDING');assert.equal(r.auto_retry_blocked,1);assert.equal(calls,1);assert.deepEqual(r.payload,s.payload);
    }finally{db.close();}
  });
});
test('single-flight coalesces events and drains record inserted during active upload in FIFO; SYNCED never resent',async()=> {
  const {repo,db}=database(),a=snapshot(),b=snapshot(),seen:string[]=[];let release!:()=>void,entered!:()=>void,concurrent=0,max=0;
  const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  try {await repo.initialize();await repo.insert(a);const sync=new SyncCoordinator(repo,async s=>{max=Math.max(max,++concurrent);seen.push(s.payload.local_id);if(seen.length===1){entered();await gate;}concurrent--;return {status:201,body:response(s)};});
    const active=sync.trigger();await started;await repo.insert(b);const same=sync.trigger();assert.equal(same,active);sync.trigger();release();await active;await sync.trigger();assert.deepEqual(seen,[a.payload.local_id,b.payload.local_id]);assert.equal(max,1);assert.ok((await repo.list()).every(r=>r.status==='SYNCED'));
  }finally{release?.();db.close();}
});
test('remote commit then lost response retries exact UUID/payload/photo after file reopen and confirms replay 200',async()=> {
  const first=database(),s=snapshot();let now=1,remote:string|undefined,attempts=0;
  const send=async(input:typeof s)=>{const exact=JSON.stringify({payload:input.payload,photo:input.photo,bytes:readFileSync(input.photo.uri).toString('base64')});attempts++;if(!remote){remote=exact;throw Error('response lost after commit');}assert.equal(exact,remote);return {status:200,body:response(input)};};
  await first.repo.initialize();await first.repo.insert(s);await new SyncCoordinator(first.repo,send,()=>{},()=>now).trigger();first.db.close();
  const reopened=database(first.path);
  try {await reopened.repo.initialize();now=100000;const sync=new SyncCoordinator(reopened.repo,send,()=>{},()=>now);await sync.trigger();await sync.trigger();assert.equal(attempts,2);assert.equal((await reopened.repo.list())[0].status,'SYNCED');}
  finally{reopened.db.close();}
});
test('finally unlocks coordinator after repository failure',async()=>{
  const {repo,db}=database(),s=snapshot();try{await repo.initialize();await repo.insert(s);const original=repo.next.bind(repo);let fail=true;repo.next=async now=>{if(fail){fail=false;throw Error('db');}return original(now);};const sync=new SyncCoordinator(repo,async row=>({status:201,body:response(row)}));await assert.rejects(sync.trigger());await sync.trigger();assert.equal((await repo.list())[0].status,'SYNCED');}finally{db.close();}
});
test('background never starts another queued upload; foreground trigger resumes',async()=>{
  const {repo,db}=database(),a=snapshot(),b=snapshot();let active=false,calls=0;
  try{await repo.initialize();await repo.insert(a);await repo.insert(b);
    const sync=new SyncCoordinator(repo,async s=>{calls++;active=false;return {status:201,body:response(s)};},()=>{},Date.now,()=>active);
    await sync.trigger();assert.equal(calls,0);active=true;await sync.trigger();assert.equal(calls,1);assert.deepEqual((await repo.list()).map(r=>r.status),['SYNCED','PENDING']);active=true;await sync.trigger();assert.equal(calls,2);
  }finally{db.close();}
});
