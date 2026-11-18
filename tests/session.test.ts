import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MobileSession } from '../src/session';
import { migrations } from '../src/repository';
import { SyncCoordinator } from '../src/sync';
import { database, response, snapshot } from './support';

const base = 'https://gateway.test';
function sessionBody(token: string, expiresAt = Date.now() + 60_000) {
  return { user: { id: 'fixture', role: 'operator' }, access_token: token, token_type: 'Bearer', expires_at: new Date(expiresAt).toISOString() };
}

test('Gateway fixture: 401 suspends FIFO and re-login uploads the unchanged queue; logout sends Bearer and stops sync', async () => {
  const { repo, db } = database();
  const first = snapshot(), second = snapshot();
  const states: boolean[] = [];
  const queue = [first, second];
  let logins = 0, uploads = 0, logouts = 0;
  const auth = new MobileSession(active => states.push(active), async (url, init) => {
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    const headers = new Headers(init.headers);
    assert.equal(headers.has('Cookie'), false);
    assert.equal(headers.has('Origin'), false);
    if (url === `${base}/v1/live/auth/login`) {
      assert.equal(headers.has('Authorization'), false);
      assert.equal(headers.get('Content-Type'), 'application/json');
      assert.deepEqual(JSON.parse(String(init.body)), { username: 'fixture', password: 'fixture-value', client: 'mobile' });
      return Response.json(sessionBody(`fixture-token-${++logins}`));
    }
    assert.equal(headers.get('Authorization'), `Bearer fixture-token-${logins}`);
    if (url === `${base}/v1/live/auth/logout`) {
      logouts++;
      return new Response(null, { status: 204 });
    }
    assert.equal(url, `${base}/v1/audit/weighings/sync`);
    assert.ok(init.body instanceof FormData);
    const row = queue[Math.max(0, uploads - 1)];
    assert.deepEqual(JSON.parse(String(init.body.get('weighing'))), row.payload);
    const photo = init.body.get('romaneio');
    assert.ok(photo instanceof Blob);
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), readFileSync(row.photo.uri));
    return ++uploads === 1 ? Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 })
      : Response.json(response(row), { status: 201 });
  });
  const sync = new SyncCoordinator(repo, async row => {
    const session = auth.current();
    if (!session) return null;
    const form = new FormData();
    form.append('weighing', JSON.stringify(row.payload));
    form.append('romaneio', new Blob([new Uint8Array(readFileSync(row.photo.uri))], { type: row.photo.mime_type }), 'romaneio.png');
    return auth.upload(session, form, 1000);
  }, undefined, Date.now, () => Boolean(auth.current()));
  try {
    await repo.initialize();
    await repo.insert(first);
    await sync.trigger();
    assert.equal(uploads, 0);
    await auth.login(base, 'fixture', 'fixture-value');
    await sync.trigger();
    await repo.insert(second);
    await sync.trigger();
    assert.equal(uploads, 1);
    assert.deepEqual((await repo.list()).map(row => [row.status, row.attempts, row.auto_retry_blocked]), [['PENDING', 0, 0], ['PENDING', 0, 0]]);
    assert.deepEqual((await repo.list()).map(({ payload, photo }) => ({ payload, photo })), queue);
    await auth.login(base, 'fixture', 'fixture-value');
    await sync.trigger();
    assert.equal(uploads, 3);
    assert.ok((await repo.list()).every(row => row.status === 'SYNCED'));
    assert.equal(await auth.logout(), 204);
    const offline = snapshot();
    await repo.insert(offline);
    await sync.trigger();
    assert.equal(logouts, 1);
    assert.equal(uploads, 3);
    assert.equal((await repo.list())[2].status, 'PENDING');
    assert.deepEqual(states, [true, false, true, false]);
  } finally { auth.clear(); db.close(); }
});

test('expired or stale sessions cannot authorize uploads; delayed 401 leaves new session active', async t => {
  let sent = 0, token = 'first', resolveUpload!: (response: Response) => void;
  let expiry: number | undefined;
  const auth = new MobileSession(() => {}, async (url) => {
    if (url.endsWith('/login')) return Response.json(sessionBody(token, expiry));
    sent++;
    return new Promise<Response>(resolve => { resolveUpload = resolve; });
  });
  try {
    expiry = Date.now() - 1;
    await assert.rejects(auth.login(base, 'fixture', 'fixture-value'), /INVALID_SESSION/);
    assert.equal(auth.current(), undefined);
    expiry = undefined;
    await auth.login(base, 'fixture', 'fixture-value');
    const old = auth.current()!;
    const upload = auth.upload(old, new FormData(), 1000);
    auth.clear();
    token = 'second';
    await auth.login('https://other-gateway.test', 'fixture', 'fixture-value');
    resolveUpload(new Response(null, { status: 401 }));
    assert.equal((await upload)?.status, 401);
    assert.equal(auth.current()?.base, 'https://other-gateway.test');
    assert.equal(await auth.upload(old, new FormData(), 1000), null);
    assert.equal(sent, 1);
    const expiresAt = auth.current()!.expiresAt;
    t.mock.method(Date, 'now', () => expiresAt);
    assert.equal(auth.current(), undefined);
  } finally { auth.clear(); }
});

test('Gateway fixture: failed logout still clears the local session', async () => {
  const auth = new MobileSession(() => {}, async url => {
    if (url.endsWith('/login')) return Response.json(sessionBody('fixture-token'));
    throw Error('offline');
  });
  try {
    await auth.login(base, 'fixture', 'fixture-value');
    const old = auth.current()!;
    await assert.rejects(auth.logout(), /offline/);
    assert.equal(auth.current(), undefined);
    assert.equal(await auth.upload(old, new FormData(), 1000), null);
  } finally { auth.clear(); }
});

test('real SQLite migration releases legacy access blocks and preserves permanent failures and evidence', async () => {
  const { db, path } = database();
  const legacy = snapshot(), permanent = snapshot();
  try {
    db.exec(`CREATE TABLE migrations(version INTEGER PRIMARY KEY); INSERT INTO migrations VALUES(1); ${migrations[0]}`);
    const insert = db.prepare("INSERT INTO weighings(local_id,payload,photo,gross,tare,net,created_order,auto_retry_blocked,next_attempt_at,last_error) VALUES(?,?,?,?,?,?,?,1,123,?)");
    for (const [index, row] of [legacy, permanent].entries()) {
      const p = row.payload;
      insert.run(p.local_id, JSON.stringify(p), JSON.stringify(row.photo), p.peso_bruto_kg, p.tara_kg, p.peso_liquido_kg,
        index, index === 0 ? 'Falha de acesso/configuração. Procure suporte.' : 'HTTP_415');
    }
  } finally { db.close(); }
  const reopened = database(path);
  try {
    await reopened.repo.initialize();
    const [released, blocked] = await reopened.repo.list();
    assert.deepEqual([released.auto_retry_blocked, released.next_attempt_at, released.last_error], [0, 0, null]);
    assert.deepEqual({ payload: released.payload, photo: released.photo }, legacy);
    assert.deepEqual([blocked.auto_retry_blocked, blocked.next_attempt_at, blocked.last_error], [1, 123, 'HTTP_415']);
  } finally { reopened.db.close(); }
});
