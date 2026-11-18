import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { canonical, confirmation, photoLimits, type Snapshot } from '../../src/domain';
import { imageDimensions } from '../../src/image';

// JPEG COM segments are legal metadata, not trailing padding. Keep the original
// compressed pixels unchanged and exercise Audit's actual full libvips decoder.
function jpegAtSize(source: Buffer, target: number) {
  assert.equal(source.readUInt16BE(0), 0xffd8);
  let remaining = target - source.length;
  assert.ok(remaining >= 4);
  const chunks = [source.subarray(0, 2)];
  while (remaining) {
    let total = Math.min(remaining, 65537);
    if (remaining > total && remaining - total < 4) total -= 4;
    const segment = Buffer.alloc(total, 0x20);
    segment.writeUInt16BE(0xfffe, 0);
    segment.writeUInt16BE(total - 2, 2);
    chunks.push(segment); remaining -= total;
  }
  const result = Buffer.concat([...chunks, source.subarray(2)]);
  assert.equal(result.length, target);
  return result;
}

test('OPT-IN partial technical contract: real Audit isolated PostgreSQL schema/storage 201/200/409 and lost response', { skip: process.env.MOBILE_AUDIT_CONTRACT !== '1', timeout: 45000 }, async () => {
  // Import the real Audit source without changing its files, binding or credentials.
  const auditModule = (name: string) => import(pathToFileURL(resolve('../agrotrac-audit/src', name)).href);
  const [{ configuration }, { migrate }, { DiskPhotos }, { PgWeighings }, { PgLedger }, { Weighings }, { Audit }, { http }] = await Promise.all(['infra/config.ts','infra/migration.ts','infra/storage.ts','infra/pg-weighings.ts','infra/postgres.ts','application/weighings.ts','application/ledger.ts','infra/http.ts'].map(auditModule));
  const schema = `mobile_contract_${Date.now()}_${randomUUID().replaceAll('-','').slice(0,8)}`;
  process.env.AUDIT_DB_SCHEMA = schema;
  const config = configuration(), {pool}=config;
  const root = resolve('tests/fixtures', schema);
  let app: any;
  try {
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,'agrotrac_audit');
    await migrate(pool,schema,true);
    const storage = new DiskPhotos(root); await storage.init();
    const service = new Weighings(new PgWeighings(pool,schema),storage);
    app = http(new Audit(new PgLedger(pool,schema)),{service,storage,maxJsonBytes:65536});
    const receivedBodies = new Map<string, number>();
    app.addHook('onRequest', async (req: any) => {
      const label = req.headers['x-mobile-boundary-case'];
      if (typeof label === 'string') {
        receivedBodies.set(label, 0);
        req.raw.on('data', (chunk: Buffer) => receivedBodies.set(label, receivedBodies.get(label)! + chunk.length));
      }
    });
    let lose = false;
    app.addHook('onSend',async (_req: any,reply: any,payload: unknown)=>{if(lose){lose=false;reply.raw.destroy();}return payload;});
    const url=await app.listen({host:'127.0.0.1',port:0});
    // Generate a fully decodable real PNG through Audit's installed sharp; preserve it.
    const sharp = createRequire(resolve('../agrotrac-audit/package.json'))('sharp');
    const bytes:Buffer=await sharp({create:{width:64,height:48,channels:3,background:'#ffffff'}}).png().toBuffer();
    const jpeg:Buffer=await sharp({create:{width:48,height:64,channels:3,background:'#ffffff'}}).jpeg().toBuffer();
    assert.deepEqual(imageDimensions(bytes),{width:64,height:48});
    assert.deepEqual(imageDimensions(jpeg),{width:48,height:64});
    await mkdir(root,{recursive:true});await writeFile(resolve(root,'mobile-source.png'),bytes,{flag:'wx'});await writeFile(resolve(root,'mobile-source.jpg'),jpeg,{flag:'wx'});
    const s:Snapshot={payload:canonical({local_id:randomUUID(),placa:'ABC1D23',peso_bruto_kg:42000,tara_kg:14000}),photo:{uri:resolve(root,'mobile-source.png'),mime_type:'image/png',file_sha256:createHash('sha256').update(bytes).digest('hex'),file_size_bytes:bytes.length,width:64,height:48}};
    async function send(payload:unknown=s.payload){
      const form=new FormData();form.append('weighing',JSON.stringify(payload));form.append('romaneio',new Blob([new Uint8Array(bytes)],{type:'image/png'}),'romaneio.png');
      const r=await fetch(`${url}/v1/audit/weighings/sync`,{method:'POST',body:form,signal:AbortSignal.timeout(5000)});
      return {status:r.status,body:await r.json()};
    }
    const first=await send();assert.equal(first.status,201);const confirmed=confirmation(s,first.body);
    const replay=await send();assert.equal(replay.status,200);assert.deepEqual(confirmation(s,replay.body),confirmed);
    assert.equal((await send({...s.payload,placa:'XYZ9A99'})).status,409);
    const lost={...s.payload,local_id:randomUUID()};lose=true;await assert.rejects(send(lost));
    const recovered=await send(lost);assert.equal(recovered.status,200);confirmation({...s,payload:lost},recovered.body);
    assert.equal(Number((await pool.query(`SELECT count(*) AS n FROM "${schema}".weighings`)).rows[0].n),2);

    assert.equal(storage.maxBytes, 10485760); // Real default, never a reduced fixture limit.
    const boundaryEvidence: Record<string, unknown>[] = [];
    const exact = jpegAtSize(jpeg, storage.maxBytes), over = jpegAtSize(jpeg, storage.maxBytes + 1);
    assert.equal(photoLimits(exact, 'image/jpeg', 48, 64), 'image/jpeg');
    assert.throws(() => photoLimits(over, 'image/jpeg', 48, 64));
    for (const photo of [exact, over]) {
      assert.deepEqual(imageDimensions(photo), { width: 48, height: 64 });
      const decoded = await sharp(photo, { failOn: 'warning', limitInputPixels: 16777216 }).raw().toBuffer({ resolveWithObject: true });
      assert.equal(decoded.info.width, 48); assert.equal(decoded.info.height, 64);
      assert.equal(decoded.data.length, 48 * 64 * 3);
      await writeFile(resolve(root, `boundary-${photo.length}.jpg`), photo, { flag: 'wx' });
    }
    const exactSnapshot: Snapshot = { payload: { ...s.payload, local_id: randomUUID() }, photo: { uri: resolve(root, `boundary-${exact.length}.jpg`), mime_type: 'image/jpeg', file_sha256: createHash('sha256').update(exact).digest('hex'), file_size_bytes: exact.length, width: 48, height: 64 } };
    async function boundaryPost(snapshot: Snapshot, photo: Buffer, label: string) {
      const form = new FormData(); form.append('weighing', JSON.stringify(snapshot.payload));
      form.append('romaneio', new Blob([new Uint8Array(photo)], { type: 'image/jpeg' }), 'romaneio.jpg');
      const request = new Request(`${url}/v1/audit/weighings/sync`, { method: 'POST', body: form, headers: { 'x-mobile-boundary-case': label }, signal: AbortSignal.timeout(15000) });
      // Request/FormData owns the boundary; clone measures the exact encoded body.
      const encodedBytes = (await request.clone().arrayBuffer()).byteLength;
      assert.ok(encodedBytes > 10485760);
      const response = await fetch(request), body: any = await response.json();
      assert.equal(receivedBodies.get(label), encodedBytes, 'server must receive the complete measured multipart body');
      boundaryEvidence.push({ label, local_id: snapshot.payload.local_id, file_bytes: photo.length, body_bytes: encodedBytes, server_received_body_bytes: receivedBodies.get(label), status: response.status, file_sha256: snapshot.photo.file_sha256 });
      return { status: response.status, body };
    }
    const accepted = await boundaryPost(exactSnapshot, exact, 'exact-created'); assert.equal(accepted.status, 201);
    const exactConfirmation = confirmation(exactSnapshot, accepted.body);
    const repeated = await boundaryPost(exactSnapshot, exact, 'exact-replay'); assert.equal(repeated.status, 200);
    assert.deepEqual(confirmation(exactSnapshot, repeated.body), exactConfirmation);
    const persisted = (await pool.query(`SELECT file_sha256,file_size_bytes,file_mime_type AS mime_type FROM "${schema}".weighings WHERE local_id=$1`, [exactSnapshot.payload.local_id])).rows;
    assert.equal(persisted.length, 1); assert.equal(persisted[0].file_sha256, exactSnapshot.photo.file_sha256);
    assert.equal(Number(persisted[0].file_size_bytes), 10485760); assert.equal(persisted[0].mime_type, 'image/jpeg');
    const storedFile = await storage.read(exactSnapshot.photo); assert.ok(storedFile.ok);
    assert.equal(createHash('sha256').update(storedFile.value).digest('hex'), exactSnapshot.photo.file_sha256);
    const overSnapshot: Snapshot = { payload: { ...s.payload, local_id: randomUUID() }, photo: { ...exactSnapshot.photo, uri: resolve(root, `boundary-${over.length}.jpg`), file_size_bytes: over.length, file_sha256: createHash('sha256').update(over).digest('hex') } };
    const rejected = await boundaryPost(overSnapshot, over, 'over-rejected'); assert.equal(rejected.status, 413);
    assert.equal(rejected.body.error.code, 'FILE_TOO_LARGE');
    assert.equal(Number((await pool.query(`SELECT count(*) AS n FROM "${schema}".weighings WHERE local_id=$1`, [overSnapshot.payload.local_id])).rows[0].n), 0);
    assert.equal(Number((await pool.query(`SELECT count(*) AS n FROM "${schema}".weighings`)).rows[0].n), 3);
    await writeFile(resolve(root,'result.json'),JSON.stringify({schema,storage:root,statuses:[201,200,409],lost_response_retry:200,boundary:boundaryEvidence,exact_sql: persisted[0],exact_sql_rows:1,over_sql_rows:0,total_sql_rows:3,native:false,gateway:false},null,2),{flag:'wx'});
    console.log(`FILE_LIMIT_EVIDENCE ${JSON.stringify(boundaryEvidence)}`);
    console.log(`PARTIAL_AUDIT_CONTRACT schema=${schema}; fixture=${root}; 201/200/409; lost response replay=200; servers closed in finally`);
  }finally{await app?.close();await pool.end();}
});
