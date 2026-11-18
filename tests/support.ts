import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { canonical, type Snapshot } from '../src/domain';
import { Repository, type Sqlite } from '../src/repository';
export const fixtureRoot = resolve('tests/fixtures', `${Date.now()}-${randomUUID()}`);
mkdirSync(fixtureRoot, { recursive: true });
export const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC', 'base64');
export function snapshot(): Snapshot {
  const id = randomUUID(), uri = resolve(fixtureRoot, `${id}.png`);
  writeFileSync(uri, image, { flag: 'wx' });
  return Object.freeze({ payload: canonical({ local_id: id, placa: 'ABC1D23', peso_bruto_kg: 45000, tara_kg: 15000 }), photo: Object.freeze({ uri, mime_type: 'image/png', file_sha256: createHash('sha256').update(image).digest('hex'), file_size_bytes: image.length, width: 1, height: 1 }) });
}
export function database(path = resolve(fixtureRoot, `${randomUUID()}.db`)) {
  const db = new DatabaseSync(path);
  const driver: Sqlite = {
    execAsync: async sql => { db.exec(sql); },
    runAsync: async (sql, ...params) => ({ changes: Number(db.prepare(sql).run(...params).changes) }),
    getAllAsync: async <T>(sql: string, ...params: (string | number | null)[]) => db.prepare(sql).all(...params) as T[],
  };
  return { repo: new Repository(driver), db, path };
}
export const response = (s: Snapshot) => ({ ...s.payload, sequence: '123', received_at: '2026-11-16T12:00:00.000Z', romaneio: { file_sha256: s.photo.file_sha256, file_size_bytes: s.photo.file_size_bytes, mime_type: s.photo.mime_type } });
