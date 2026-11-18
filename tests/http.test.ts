import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { apiUrl, postMultipart } from '../src/http';
import { SyncCoordinator } from '../src/sync';
import { database, snapshot } from './support';
test('transport preserves supplied FormData, leaves boundary to fetch and supplies abort signal',async()=>{
  const form=new FormData();form.append('weighing','{}');form.append('romaneio',new Blob(['test'],{type:'image/png'}),'photo.png');
  let calls=0;
  const request:typeof fetch=async(url,options)=>{calls++;assert.equal(url,'https://gateway.test/v1/audit/weighings/sync');assert.equal(options?.headers,undefined);assert.equal(options?.body,form);assert.deepEqual([...form.keys()],['weighing','romaneio']);assert.equal(options?.method,'POST');return new Response('{"sequence":"1"}',{status:201});};
  assert.equal((await postMultipart('https://gateway.test/',form,1000,request)).status,201);assert.equal(calls,1);
  for(const bad of ['file:///secret','http://user:pass@host','https://host?a=1','https://host/#token'])assert.throws(()=>apiUrl(bad));
});
test('real host HTTP timeout and malformed success body keep SQLite pending; invalid permanent body still blocks',async()=>{
  const server=createServer((req,res)=>{req.resume();if(req.url?.startsWith('/timeout'))return;if(req.url?.startsWith('/permanent'))res.statusCode=415;res.end('not JSON');});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const address=server.address();assert.ok(address&&typeof address==='object');
  try{
    for(const route of ['/timeout','/invalid','/permanent']){
      const {repo,db}=database(),s=snapshot();try{await repo.initialize();await repo.insert(s);
        const sync=new SyncCoordinator(repo,()=>postMultipart(`http://127.0.0.1:${address.port}${route}`,new FormData(),route==='/timeout'?80:2000));
        await sync.trigger();const row=(await repo.list())[0];assert.equal(row.status,'PENDING');assert.equal(row.auto_retry_blocked,route==='/permanent'?1:0);assert.equal(row.last_error,route==='/permanent'?'HTTP_415':route==='/invalid'?'INVALID_CONFIRMATION':'NETWORK_TIMEOUT_OR_UPLOAD_ERROR');
      }finally{db.close();}
    }
  }finally{server.closeAllConnections();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
});
