import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleAccountApi } from '../server/account-api.mjs';

const ORIGIN = 'https://pinstudio.example';
const A = { userId: 'account-a', email: 'a@example.com', displayName: 'Alice' };
const B = { userId: 'account-b', email: 'b@example.com', displayName: 'Bob' };
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEwAAAABJRU5ErkJggg==', 'base64'));
const JPEG = Uint8Array.from([255, 216, 255, 224, 0, 0, 255, 217]);
const WEBP = Uint8Array.from(Buffer.from('524946460400000057454250', 'hex'));

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE libraries(owner_id TEXT PRIMARY KEY,payload TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE assets(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,object_key TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,created_at INTEGER NOT NULL);`);
  t.after(() => sqlite.close());
  const db = { prepare(sql) {
    const statement = sqlite.prepare(sql); let params = [];
    return { bind(...values) { params = values; return this; }, async first() { return statement.get(...params) ?? null; }, async run() { return statement.run(...params); } };
  } };
  const objects = new Map();
  const bucket = {
    async put(key, bytes, options) { objects.set(key, { bytes: Uint8Array.from(bytes), options }); },
    async get(key) { const item = objects.get(key); return item ? { body: new Blob([item.bytes]).stream() } : null; },
    async delete(key) { objects.delete(key); },
  };
  const context = user => ({ user, db, bucket });
  const call = (request, user = A, expectedAccount = user?.userId) => {
    const headers = new Headers(request.headers);
    if (expectedAccount == null) headers.delete('X-PinStudio-Account');
    else headers.set('X-PinStudio-Account', expectedAccount);
    return handleAccountApi(new Request(request, { headers }), context(user));
  };
  return { sqlite, db, bucket, objects, context, call };
}
function req(path, { method = 'GET', body, origin = ORIGIN, type, headers = {} } = {}) {
  const options = { method, headers: { ...headers } };
  if (method !== 'GET') {
    if (origin !== null) options.headers.Origin = origin;
    if (type) options.headers['Content-Type'] = type;
    if (body !== undefined) options.body = body;
    if (body instanceof ReadableStream) options.duplex = 'half';
  }
  return new Request(ORIGIN + path, options);
}
function library(name = 'Personal collection') {
  return { boards: [{ id: 'inspiration', name, pins: ['123'], createdAt: 100 }], pins: {
    '123': { id: '123', title: 'Mountain', author: 'Photographer', width: 800, height: 600,
      image: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Mountain.jpg',
      source: 'https://commons.wikimedia.org/wiki/File:Mountain.jpg', license: 'CC BY 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' },
  } };
}
function put(value, revision = 0, options = {}) { return req('/api/library', { method: 'PUT', type: 'application/json', body: JSON.stringify({ library: value, revision }), ...options }); }
function upload(bytes = PNG, mime = 'image/png', options = {}) { return req('/api/assets', { method: 'POST', type: mime, body: bytes, ...options }); }

test('session endpoint discloses only trusted context identity and has non-cacheable responses', async () => {
  const anonymous = await handleAccountApi(req('/api/session', { headers: { 'x-user-id': A.userId, 'x-openai-user-id': A.userId } }), {});
  assert.equal(anonymous.status, 200);
  assert.deepEqual((await anonymous.json()).user, null);
  const response = await handleAccountApi(req('/api/session?userId=spoof'), { user: A });
  const data = await response.json();
  assert.equal(data.authenticated, true);
  assert.deepEqual(data.user, { id: A.userId, email: A.email, displayName: A.displayName });
  assert.equal(data.signInUrl, '/signin-with-chatgpt?return_to=%2F');
  assert.equal(data.signOutUrl, '/signout-with-chatgpt?return_to=%2F');
  assert.match(response.headers.get('cache-control'), /no-store/);
});

test('anonymous reads, writes, uploads and asset reads are denied even with forged identity headers', async t => {
  const { call } = fixture(t);
  for (const request of [req('/api/library', { headers: { 'x-openai-user-id': A.userId } }), put(library()), upload(), req('/api/assets/12345678-1234-1234-1234-123456789012')]) {
    const response = await call(request, null);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'unauthorized');
    assert.match(response.headers.get('cache-control'), /no-store/);
  }
});

test('new accounts get independent empty default collections with revision zero', async t => {
  const { call } = fixture(t);
  const a = await (await call(req('/api/library'), A)).json();
  const b = await (await call(req('/api/library'), B)).json();
  assert.equal(a.revision, 0);
  assert.equal(a.library.boards[0].id, 'inspiration');
  assert.deepEqual(a.library.pins, {});
  assert.deepEqual(a, b);
});

test('missing or mismatched expected account blocks library reads, writes and uploads before storage access', async t => {
  const { call, sqlite, objects } = fixture(t);
  for (const expectedAccount of [null, '', B.userId]) {
    for (const request of [req('/api/library'), put(library()), upload()]) {
      const response = await call(request, A, expectedAccount);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, 'account_changed');
      assert.match(response.headers.get('cache-control'), /no-store/);
    }
  }
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM libraries').get().n, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 0);
  assert.equal(objects.size, 0);
});

test('switching accounts with equal revisions cannot save the stale account library or image into the new account', async t => {
  const { call, objects } = fixture(t);
  const initialA = await (await call(put(library('Alice private')), A)).json();
  const initialB = await (await call(put(library('Bob private')), B)).json();
  assert.equal(initialA.revision, initialB.revision);
  const switched = await call(put(initialA.library, initialA.revision), B, A.userId);
  assert.equal(switched.status, 409);
  assert.equal((await switched.json()).code, 'account_changed');
  const staleUpload = await call(upload(), B, A.userId);
  assert.equal(staleUpload.status, 409);
  assert.equal((await staleUpload.json()).code, 'account_changed');
  assert.equal(objects.size, 0);
  for (const [user, initial] of [[A, initialA], [B, initialB]]) {
    const actual = await (await call(req('/api/library'), user)).json();
    assert.deepEqual(actual, initial);
  }
});

test('two users cannot read or overwrite each other through owner query or JSON spoofing', async t => {
  const { call, sqlite } = fixture(t);
  const a = library('Alice private'); a.owner_id = B.userId; a.boards[0].ownerId = B.userId;
  assert.equal((await call(put(a), A)).status, 200);
  const spoofed = req(`/api/library?userId=${A.userId}&owner_id=${A.userId}`, { method: 'PUT', type: 'application/json',
    body: JSON.stringify({ owner_id: A.userId, userId: A.userId, revision: 0, library: library('Bob private') }) });
  assert.equal((await call(spoofed, B)).status, 200);
  const aRead = await (await call(req(`/api/library?userId=${B.userId}`), A)).json();
  const bRead = await (await call(req(`/api/library?owner_id=${A.userId}`), B)).json();
  assert.equal(aRead.library.boards[0].name, 'Alice private');
  assert.equal(bRead.library.boards[0].name, 'Bob private');
  assert.equal(aRead.library.owner_id, undefined);
  assert.equal(aRead.library.boards[0].ownerId, undefined);
  assert.deepEqual(sqlite.prepare('SELECT owner_id FROM libraries ORDER BY owner_id').all().map(row => row.owner_id), [A.userId, B.userId]);
});

test('optimistic revisions reject stale creates and updates without changing saved data', async t => {
  const { call } = fixture(t);
  assert.equal((await (await call(put(library('first')))).json()).revision, 1);
  assert.equal((await call(put(library('stale create')))).status, 409);
  assert.equal((await (await call(put(library('second'), 1))).json()).revision, 2);
  const stale = await call(put(library('stale update'), 1));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'revision_conflict');
  assert.equal((await (await call(req('/api/library'))).json()).library.boards[0].name, 'second');
  assert.equal((await call(put(library(), 8), B)).status, 409);
});

test('simultaneous edits at the same revision permit exactly one writer', async t => {
  const { call } = fixture(t);
  await call(put(library()));
  const replies = await Promise.all([call(put(library('left'), 1)), call(put(library('right'), 1))]);
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 409]);
  assert.equal((await (await call(req('/api/library'))).json()).revision, 2);
});

test('missing, cross-origin, null and lookalike origins cannot mutate collections or assets', async t => {
  const { call, sqlite, objects } = fixture(t);
  for (const origin of [null, 'null', 'https://evil.example', ORIGIN + '.evil.example', 'http://pinstudio.example']) {
    assert.equal((await call(put(library(), 0, { origin }))).status, 403);
    assert.equal((await call(upload(PNG, 'image/png', { origin }))).status, 403);
  }
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM libraries').get().n, 0);
  assert.equal(objects.size, 0);
});

test('library body requires JSON and rejects invalid UTF-8, malformed JSON and invalid revisions', async t => {
  const { call } = fixture(t);
  assert.equal((await call(put(library(), 0, { type: 'text/plain' }))).status, 415);
  for (const body of ['{broken', 'null', '{}', JSON.stringify({ library: library(), revision: -1 }), Uint8Array.from([255])]) {
    assert.equal((await call(req('/api/library', { method: 'PUT', type: 'application/json', body }))).status, 400);
  }
});

test('streaming limits cannot be bypassed by omitting or understating Content-Length', async t => {
  const { call, objects } = fixture(t);
  const stream = (size, chunk) => new ReadableStream({ start(controller) { for (let i = 0; i < size; i++) controller.enqueue(new Uint8Array(chunk)); controller.close(); } });
  const jsonResponse = await call(req('/api/library', { method: 'PUT', type: 'application/json', body: stream(17, 65536) }));
  assert.equal(jsonResponse.status, 413);
  const assetResponse = await call(upload(stream(161, 65536), 'image/png', { headers: { 'Content-Length': '1' } }));
  assert.equal(assetResponse.status, 413);
  assert.equal(objects.size, 0);
  assert.equal((await call(upload(PNG, 'image/png', { headers: { 'Content-Length': String(10 * 1024 * 1024 + 1) } }))).status, 413);
});

test('unsafe images and source URLs are rejected before any library write', async t => {
  const { call, sqlite } = fixture(t);
  for (const image of ['data:image/png;base64,AAAA', 'blob:https://pinstudio.example/id', 'javascript:alert(1)', 'https://upload.wikimedia.org.evil.example/wikipedia/commons/x.jpg', '//evil.example/a.png', 'https://pinstudio.example/api/assets/12345678-1234-1234-1234-123456789012']) {
    const value = library(); value.pins['123'].image = image;
    assert.equal((await call(put(value))).status, 400, image);
  }
  for (const key of ['source', 'licenseUrl']) { const value = library(); value.pins['123'][key] = 'javascript:alert(1)'; assert.equal((await call(put(value))).status, 400); }
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM libraries').get().n, 0);
});

test('invalid ids, duplicates, missing pin references and oversized collections are rejected', async t => {
  const { call } = fixture(t);
  const mutations = [
    value => { value.boards[0].id = '__proto__'; },
    value => { value.boards.push(structuredClone(value.boards[0])); },
    value => { value.boards[0].pins.push('123'); },
    value => { value.boards[0].pins.push('missing'); },
    value => { value.pins['123'].id = 'different'; },
    value => { value.boards[0].name = ' '; },
    value => { value.boards[0].name = 'x'.repeat(61); },
    value => { value.pins['123'].title = 'x'.repeat(241); },
    value => { value.pins['123'].width = 0; },
    value => { value.pins['123'].height = '600'; },
    value => { value.boards = Array.from({ length: 101 }, (_, n) => ({ ...value.boards[0], id: String(n) })); },
    value => { value.pins = Object.fromEntries(Array.from({ length: 1001 }, (_, n) => [String(n), { ...value.pins['123'], id: String(n) }])); },
  ];
  for (const mutate of mutations) { const value = library(); mutate(value); assert.equal((await call(put(value))).status, 400); }
});

test('normalization strips unknown fields and derives local status from validated URL', async t => {
  const { call } = fixture(t);
  const value = library(); value.pins['123'].local = true; value.pins['123'].owner_id = B.userId;
  value.pins['123'].html = '<script>attack()</script>'; value.pins['123'].title = '<b>Plain title</b>';
  const saved = await (await call(put(value))).json();
  assert.equal(saved.library.pins['123'].local, false);
  assert.equal(saved.library.pins['123'].owner_id, undefined);
  assert.equal(saved.library.pins['123'].html, undefined);
  assert.equal(saved.library.pins['123'].title, '<b>Plain title</b>'); // Remains data, never executable HTML.
});

test('valid image upload stays private and serves byte-identical data only to its owner', async t => {
  const { call, objects, sqlite } = fixture(t);
  const uploadResponse = await call(upload());
  assert.equal(uploadResponse.status, 201);
  const asset = await uploadResponse.json();
  assert.match(asset.id, /^[a-f0-9-]{36}$/);
  assert.equal(asset.image, '/api/assets/' + asset.id);
  const row = sqlite.prepare('SELECT * FROM assets WHERE id=?').get(asset.id);
  assert.equal(row.owner_id, A.userId);
  assert.equal(row.object_key, A.userId + '/' + asset.id);
  assert.equal(objects.size, 1);
  const own = await call(req(asset.image));
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('content-type'), 'image/png');
  assert.equal(own.headers.get('x-content-type-options'), 'nosniff');
  assert.match(own.headers.get('cache-control'), /private, no-store/);
  assert.deepEqual(new Uint8Array(await own.arrayBuffer()), PNG);
  assert.equal((await call(req(asset.image), B)).status, 404);
  assert.equal((await call(req(asset.image), null)).status, 401);
  assert.equal((await call(req(asset.image + `?owner_id=${A.userId}`), B)).status, 404);
});

test('PNG, JPEG and WebP signatures must match MIME, unsupported types never enter storage', async t => {
  const { call, objects } = fixture(t);
  for (const [bytes, mime] of [[PNG, 'image/png'], [JPEG, 'image/jpeg'], [WEBP, 'image/webp']]) assert.equal((await call(upload(bytes, mime))).status, 201);
  assert.equal(objects.size, 3);
  assert.equal((await call(upload(PNG, 'image/jpeg'))).status, 400);
  assert.equal((await call(upload(new TextEncoder().encode('<script>bad()</script>'), 'image/png'))).status, 400);
  assert.equal((await call(upload(PNG, 'image/svg+xml'))).status, 415);
  assert.equal(objects.size, 3);
});

test('foreign and nonexistent asset references cannot be saved in a user library', async t => {
  const { call } = fixture(t);
  const asset = await (await call(upload(), A)).json();
  const value = library(); value.pins['123'].image = asset.image; value.pins['123'].local = false;
  assert.equal((await call(put(value), B)).status, 403);
  const own = await call(put(value), A);
  assert.equal(own.status, 200);
  assert.equal((await own.json()).library.pins['123'].local, true);
  value.pins['123'].image = '/api/assets/12345678-1234-1234-1234-123456789012';
  assert.equal((await call(put(value, 1), A)).status, 403);
});

test('private edited exports preserve attribution while library normalization removes ownership claims', async t => {
  const { call } = fixture(t);
  const asset = await (await call(upload())).json();
  const value = library(); Object.assign(value.pins['123'], { image: asset.image, edited: true, originalId: '456', createdAt: 1000, userId: B.userId });
  assert.equal((await call(put(value))).status, 200);
  const data = await (await call(req('/api/library'))).json();
  assert.equal(data.library.pins['123'].originalId, '456');
  assert.equal(data.library.pins['123'].author, 'Photographer');
  assert.equal(data.library.pins['123'].license, 'CC BY 4.0');
  assert.equal(data.library.pins['123'].edited, true);
  assert.equal(data.library.pins['123'].userId, undefined);
});

test('deleted bucket objects and foreign ids share a non-disclosing 404 response', async t => {
  const { call, objects } = fixture(t);
  const asset = await (await call(upload())).json(); objects.clear();
  const missing = await call(req(asset.image), A); const foreign = await call(req(asset.image), B);
  assert.equal(missing.status, 404); assert.equal(foreign.status, 404);
  assert.deepEqual(await missing.json(), await foreign.json());
});

test('missing bindings return 503; backend exceptions return generic 500 without keys or SQL', async t => {
  const { db, bucket } = fixture(t);
  const headers = { 'X-PinStudio-Account': A.userId };
  assert.equal((await handleAccountApi(req('/api/library', { headers }), { user: A })).status, 503);
  assert.equal((await handleAccountApi(upload(PNG, 'image/png', { headers }), { user: A, db })).status, 503);
  const response = await handleAccountApi(req('/api/library', { headers }), { user: A, bucket, db: { prepare() { throw new Error('SELECT secret FROM credentials key=supersecret'); } } });
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /SELECT|supersecret|credentials/);
});

test('failed asset metadata inserts clean up uploaded bytes and never expose object keys', async t => {
  const { bucket, objects } = fixture(t);
  const brokenDb = { prepare() { return { bind() { return this; }, async run() { throw new Error('private backend detail'); } }; } };
  const response = await handleAccountApi(upload(PNG, 'image/png', { headers: { 'X-PinStudio-Account': A.userId } }), { user: A, db: brokenDb, bucket });
  assert.equal(response.status, 500);
  assert.equal(objects.size, 0);
  assert.doesNotMatch(await response.text(), /account-a|backend detail/);
});

test('unknown routes and unsupported methods fail with non-cacheable responses', async t => {
  const { call } = fixture(t);
  const unknown = await call(req('/api/unknown'));
  const method = await call(req('/api/library', { method: 'POST', body: '{}' }));
  assert.equal(unknown.status, 404); assert.equal(method.status, 405);
  assert.match(method.headers.get('cache-control'), /no-store/);
});

test('client clears stale state when account changes while an upload response is pending', async t => {
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
  t.after(() => { globalThis.fetch = originalFetch; if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; });
  globalThis.window = new EventTarget();
  let eventMessage = '', current = A, completeUpload, puts = 0;
  window.addEventListener('auth-expired', event => { eventMessage = event.detail.message; });
  const uploaded = new Promise(resolve => { completeUpload = resolve; });
  globalThis.fetch = async (path, options) => {
    if (path === '/api/session') return Response.json({ authenticated: true, user: { id: current.userId } });
    if (path === '/api/library' && !options.method) return Response.json({ library: library(), revision: 1 });
    if (path === '/api/assets') { assert.equal(options.headers.get('X-PinStudio-Account'), A.userId); return uploaded; }
    puts++; return Response.json({});
  };
  const storage = await import('../public/storage.js?account-switch-regression');
  await storage.getSession(); await storage.readLibrary();
  const value = library(); Object.assign(value.pins['123'], { local: true, image: 'data:image/png;base64,' + Buffer.from(PNG).toString('base64') });
  const saving = storage.writeLibrary(value);
  current = B; await storage.getSession();
  completeUpload(Response.json({ image: '/api/assets/12345678-1234-1234-1234-123456789012' }, { status: 201 }));
  await assert.rejects(saving, /Аккаунт изменился/);
  assert.match(eventMessage, /Аккаунт изменился/);
  assert.equal(puts, 0);
  assert.deepEqual(await storage.readLibrary(), { boards: [], pins: {} });
});

test('client keeps the original revision across an upload and concurrent collection refresh', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let revision = 1, completeUpload, sentRevision;
  const uploaded = new Promise(resolve => { completeUpload = resolve; });
  globalThis.fetch = async (path, options) => {
    if (path === '/api/session') return Response.json({ authenticated: true, user: { id: A.userId } });
    assert.equal(options.headers.get('X-PinStudio-Account'), A.userId);
    if (path === '/api/library' && !options.method) return Response.json({ library: library(), revision });
    if (path === '/api/assets') return uploaded;
    sentRevision = JSON.parse(options.body).revision;
    return Response.json({ code: 'revision_conflict' }, { status: 409 });
  };
  const storage = await import('../public/storage.js?revision-capture-regression');
  await storage.getSession(); await storage.readLibrary();
  const value = library(); Object.assign(value.pins['123'], { local: true, image: 'data:image/png;base64,' + Buffer.from(PNG).toString('base64') });
  const saving = storage.writeLibrary(value);
  revision = 2; await storage.readLibrary();
  completeUpload(Response.json({ image: '/api/assets/12345678-1234-1234-1234-123456789012' }, { status: 201 }));
  await assert.rejects(saving, /Коллекция изменилась/);
  assert.equal(sentRevision, 1);
});
