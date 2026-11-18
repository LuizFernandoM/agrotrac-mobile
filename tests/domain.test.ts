import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, confirmation, kg, photoLimits, backoff } from '../src/domain';
import { snapshot, response, image } from './support';
import { imageDimensions } from '../src/image';
test('safe kg, computed zero net, invalid inputs and canonical immutable payload', () => {
  for (const v of ['-1','1.1','NaN','Infinity','9007199254740992','1e3','', ' 1']) assert.throws(() => kg(v));
  assert.equal(kg('9007199254740991'), Number.MAX_SAFE_INTEGER);
  const s = snapshot(), p = s.payload;
  assert.equal(p.peso_liquido_kg, 30000); assert.equal(p.booking_id, null); assert.ok(Object.isFrozen(p));
  const normalized = canonical({ ...p, peso_bruto_kg: 1, tara_kg: 1, extra: 'never sent', peso_liquido_kg: 999 });
  assert.equal(normalized.peso_liquido_kg, 0); assert.equal('extra' in normalized, false);
  for (const override of [{ placa:'abc1d23' },{ tara_kg:45001 },{ peso_bruto_kg:0 },{ peso_bruto_kg:Number.MAX_SAFE_INTEGER+1 },{ tara_kg:1.2 },{ booking_id:'bad' },{ captured_at:'2026-02-31T00:00:00.000Z' },{ motorista_nome:'\uD800' },{ observacoes:'x'.repeat(501) }]) assert.throws(() => canonical({ ...p,...override }));
  assert.equal(backoff(9999), 60000);
});
test('confirmation compares EVERY canonical field and all photo metadata, sequence and UTC', () => {
  const s = snapshot(), ok = response(s);
  assert.equal(confirmation(s,ok).sequence,'123');
  for (const key of Object.keys(s.payload)) assert.throws(() => confirmation(s,{ ...ok,[key]:'divergent' }));
  for (const key of ['file_sha256','file_size_bytes','mime_type']) assert.throws(() => confirmation(s,{ ...ok,romaneio:{ ...ok.romaneio,[key]:'wrong' } }));
  for (const body of [null,{}, {ok:true,value:ok},{ ...ok,sequence:'0' },{ ...ok,sequence:1 },{ ...ok,received_at:'2026-11-16T12:00:00-03:00' },{ ...ok,received_at:'2026-02-31T12:00:00.000Z' }]) assert.throws(() => confirmation(s,body));
});
test('photo MIME, byte and pixel limits', () => {
  assert.deepEqual(imageDimensions(image),{width:1,height:1});
  const corrupted=Uint8Array.from(image);corrupted[45]^=1;
  for(const invalid of [corrupted,image.subarray(0,image.length-1),new Uint8Array([255,216,255,217]),new Uint8Array(8)])assert.throws(()=>imageDimensions(invalid));
  assert.equal(photoLimits(image,'image/png',1,1),'image/png');
  for (const [bytes,mime,w,h] of [[image,'image/jpeg',1,1],[image,'image/png',8193,1],[image,'image/png',8192,8192],[new Uint8Array(10485761),'image/png',1,1],[image,'image/png',0,1],[image.subarray(0,2),'image/png',1,1]] as const) assert.throws(() => photoLimits(bytes,mime,w,h));
});
