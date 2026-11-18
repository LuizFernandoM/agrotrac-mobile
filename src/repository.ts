import { canonical, type Row, type Snapshot } from './domain';
export interface Sqlite {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: (string | number | null)[]): Promise<{ changes: number }>;
  getAllAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T[]>;
}
export const migrations = [
`CREATE TABLE weighings (
 local_id TEXT PRIMARY KEY NOT NULL,
 payload TEXT NOT NULL CHECK(json_valid(payload)), photo TEXT NOT NULL CHECK(json_valid(photo)),
 gross INTEGER NOT NULL CHECK(typeof(gross)='integer' AND gross BETWEEN 1 AND 9007199254740991),
 tare INTEGER NOT NULL CHECK(typeof(tare)='integer' AND tare BETWEEN 0 AND gross),
 net INTEGER NOT NULL CHECK(typeof(net)='integer' AND net=gross-tare),
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','IN_FLIGHT','SYNCED','FAILED_CONFLICT')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), next_attempt_at INTEGER NOT NULL DEFAULT 0,
 auto_retry_blocked INTEGER NOT NULL DEFAULT 0 CHECK(auto_retry_blocked IN (0,1)),
 last_error TEXT, sequence TEXT, received_at TEXT, created_order INTEGER NOT NULL,
 CHECK(json_extract(payload,'$.local_id')=local_id),
 CHECK(json_extract(payload,'$.peso_bruto_kg')=gross AND json_extract(payload,'$.tara_kg')=tare AND json_extract(payload,'$.peso_liquido_kg')=net),
 CHECK(json_extract(photo,'$.file_size_bytes') BETWEEN 1 AND 10485760),
 CHECK(json_extract(photo,'$.mime_type') IN ('image/jpeg','image/png'))
);
CREATE INDEX queue_fifo ON weighings(status,created_order);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TRIGGER immutable_snapshot BEFORE UPDATE OF local_id,payload,photo,gross,tare,net,created_order ON weighings BEGIN SELECT RAISE(ABORT,'immutable snapshot'); END;
CREATE TRIGGER valid_transition BEFORE UPDATE OF status ON weighings WHEN NOT (
 (OLD.status='PENDING' AND NEW.status='IN_FLIGHT') OR
 (OLD.status='IN_FLIGHT' AND NEW.status IN ('PENDING','SYNCED','FAILED_CONFLICT')) OR OLD.status=NEW.status)
 BEGIN SELECT RAISE(ABORT,'invalid transition'); END;`
];
type DbRow = Omit<Row, 'payload' | 'photo'> & { payload: string; photo: string };
export class Repository {
  private initialization?: Promise<void>;
  constructor(readonly db: Sqlite) {}
  initialize() { return this.initialization ??= this.init(); }
  private async init() {
    await this.db.execAsync('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);');
    const versions = await this.db.getAllAsync<{ version: number }>('SELECT version FROM migrations ORDER BY version');
    if (versions.some((v, i) => v.version !== i + 1) || versions.length > migrations.length) throw Error('Unknown SQLite migration history');
    for (let i = versions.length; i < migrations.length; i++) {
      await this.db.execAsync('BEGIN IMMEDIATE');
      try { await this.db.execAsync(migrations[i]); await this.db.runAsync('INSERT INTO migrations(version) VALUES(?)', i + 1); await this.db.execAsync('COMMIT'); }
      catch (e) { await this.db.execAsync('ROLLBACK'); throw e; }
    }
    await this.db.runAsync("UPDATE weighings SET status='PENDING',last_error='RECOVERED_IN_FLIGHT' WHERE status='IN_FLIGHT'");
  }
  async insert(s: Snapshot) {
    const p = canonical(s.payload);
    await this.db.runAsync('INSERT INTO weighings(local_id,payload,photo,gross,tare,net,created_order) VALUES(?,?,?,?,?,?,(SELECT coalesce(max(created_order),0)+1 FROM weighings))', p.local_id, JSON.stringify(p), JSON.stringify(s.photo), p.peso_bruto_kg, p.tara_kg, p.peso_liquido_kg);
  }
  async list(): Promise<Row[]> {
    return (await this.db.getAllAsync<DbRow>('SELECT * FROM weighings ORDER BY created_order')).map(r => ({ ...r, payload: Object.freeze(JSON.parse(r.payload)), photo: Object.freeze(JSON.parse(r.photo)) }));
  }
  async next(now: number): Promise<Row | undefined> { return (await this.list()).find(r => r.status === 'PENDING' && !r.auto_retry_blocked && r.next_attempt_at <= now); }
  async claim(id: string) { return (await this.db.runAsync("UPDATE weighings SET status='IN_FLIGHT',attempts=attempts+1 WHERE local_id=? AND status='PENDING' AND auto_retry_blocked=0", id)).changes === 1; }
  async success(id: string, c: { sequence: string; received_at: string }) { await this.db.runAsync("UPDATE weighings SET status='SYNCED',sequence=?,received_at=?,last_error=NULL WHERE local_id=? AND status='IN_FLIGHT'", c.sequence, c.received_at, id); }
  async failure(id: string, error: string, blocked: boolean, next: number, conflict = false) { await this.db.runAsync("UPDATE weighings SET status=?,last_error=?,auto_retry_blocked=?,next_attempt_at=? WHERE local_id=? AND status='IN_FLIGHT'", conflict ? 'FAILED_CONFLICT' : 'PENDING', error, blocked ? 1 : 0, next, id); }
  async setting(key: string) { return (await this.db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key=?', key))[0]?.value; }
  async setSetting(key: string, value: string) { await this.db.runAsync('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value); }
}
