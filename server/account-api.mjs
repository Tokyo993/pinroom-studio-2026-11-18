import { safeImageUrl, safeSourceUrl } from '../public/api.js';

const JSON_LIMIT = 1024 * 1024;
const IMAGE_LIMIT = 10 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ASSET_PATH = new RegExp(`^/api/assets/(${UUID})$`, 'i');
const MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const NO_STORE = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Cookie' };

class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const invalid = (message = 'Некорректные данные.') => { throw new ApiError(400, message, 'invalid_request'); };
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { ...NO_STORE, 'Content-Type': 'application/json; charset=utf-8' },
});
function requireUser(user) {
  if (!user || typeof user.userId !== 'string' || !user.userId) throw new ApiError(401, 'Войдите, чтобы открыть личные данные.', 'unauthorized');
  return user.userId;
}
function requireDb(db) {
  if (!db || typeof db.prepare !== 'function') throw new ApiError(503, 'Хранилище временно недоступно.', 'storage_unavailable');
}
function requireBucket(bucket) {
  if (!bucket || typeof bucket.get !== 'function' || typeof bucket.put !== 'function') throw new ApiError(503, 'Хранилище изображений временно недоступно.', 'storage_unavailable');
}
function requireSameOrigin(request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) throw new ApiError(403, 'Запрос из другого источника запрещён.', 'invalid_origin');
}
function requireExpectedAccount(request, ownerId) {
  // This is an account-switch guard, never an identity source. Ownership always
  // comes from Sites dispatch; a stale tab must not save A's data into B.
  if (request.headers.get('X-PinStudio-Account') !== ownerId) {
    throw new ApiError(409, 'Аккаунт изменился. Откройте профиль, чтобы загрузить актуальные коллекции.', 'account_changed');
  }
}
function contentType(request) { return (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase(); }
async function readBounded(request, limit) {
  const declared = request.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new ApiError(413, 'Файл или запрос слишком большой.', 'payload_too_large');
  if (!request.body) invalid('Пустое тело запроса.');
  const reader = request.body.getReader();
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); throw new ApiError(413, 'Файл или запрос слишком большой.', 'payload_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function identifier(value) { return typeof value === 'string' && ID.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value); }
function text(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) invalid('Некорректная длина текста.');
  return value;
}
function timestamp(value) {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) invalid('Некорректная дата.');
  return value;
}
function safeLink(value) {
  if (value === undefined || value === '') return '';
  const safe = safeSourceUrl(value);
  if (!safe) invalid('Недопустимая ссылка на источник.');
  return safe;
}
async function normalizeLibrary(input, ownerId, db) {
  if (!object(input) || !Array.isArray(input.boards) || !object(input.pins) || input.boards.length > 100) invalid('Некорректная коллекция.');
  const entries = Object.entries(input.pins);
  if (entries.length > 1000) invalid('В коллекции может быть не более 1000 пинов.');
  const pins = Object.create(null);
  const privateIds = new Set();
  for (const [key, raw] of entries) {
    if (!identifier(key) || !object(raw) || raw.id !== key) invalid('Некорректный идентификатор пина.');
    const asset = typeof raw.image === 'string' ? raw.image.match(ASSET_PATH) : null;
    const image = asset ? raw.image : safeImageUrl(raw.image);
    if (!image) invalid('Недопустимый адрес изображения.');
    if (asset) privateIds.add(asset[1]);
    if (!Number.isFinite(raw.width) || !Number.isFinite(raw.height) || raw.width <= 0 || raw.height <= 0) invalid('Некорректный размер изображения.');
    const pin = {
      id: key, title: text(raw.title, 240, true), author: text(raw.author ?? '', 180),
      image, source: safeLink(raw.source), license: text(raw.license ?? '', 100), licenseUrl: safeLink(raw.licenseUrl),
      width: raw.width, height: raw.height, local: !!asset, edited: raw.edited === true,
    };
    if (raw.originalId !== undefined) {
      if (!identifier(raw.originalId)) invalid('Некорректный идентификатор оригинала.');
      pin.originalId = raw.originalId;
    }
    if (raw.createdAt !== undefined) pin.createdAt = timestamp(raw.createdAt);
    pins[key] = pin;
  }
  const boardIds = new Set();
  const boards = input.boards.map(raw => {
    if (!object(raw) || !identifier(raw.id) || boardIds.has(raw.id) || !Array.isArray(raw.pins) || raw.pins.length > 1000) invalid('Некорректная доска.');
    boardIds.add(raw.id);
    const refs = new Set();
    for (const id of raw.pins) {
      if (!identifier(id) || !Object.hasOwn(pins, id) || refs.has(id)) invalid('Некорректная ссылка на пин.');
      refs.add(id);
    }
    return { id: raw.id, name: text(raw.name, 60, true).trim(), pins: [...refs], createdAt: timestamp(raw.createdAt) };
  });
  // Check ownership before the library can persist a private resource reference.
  // Bounded batches avoid one D1 query for each image and SQLite parameter limits.
  const ids = [...privateIds];
  for (let i = 0; i < ids.length; i += 80) {
    const batch = ids.slice(i, i + 80);
    const marks = batch.map(() => '?').join(',');
    const row = await db.prepare(`SELECT COUNT(*) AS count FROM assets WHERE owner_id = ? AND id IN (${marks})`).bind(ownerId, ...batch).first();
    if (Number(row?.count) !== batch.length) throw new ApiError(403, 'Изображение недоступно в вашей коллекции.', 'asset_forbidden');
  }
  return { boards, pins };
}
function defaultLibrary() {
  return { boards: [{ id: 'inspiration', name: 'Моё вдохновение', pins: [], createdAt: 0 }], pins: {} };
}
function matchesSignature(bytes, mime) {
  if (mime === 'image/png') return bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v);
  if (mime === 'image/jpeg') return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
  return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
}

/**
 * Identity is supplied exclusively by the trusted Sites dispatch adapter.
 * This handler deliberately never reads identity from browser headers or JSON.
 */
export async function handleAccountApi(request, { user = null, db, bucket } = {}) {
  try {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/api/session' && request.method === 'GET') {
      const authenticated = !!(user && typeof user.userId === 'string' && user.userId);
      return json({ authenticated, user: authenticated ? { id: user.userId, email: user.email ?? null, displayName: user.displayName ?? null } : null,
        signInUrl: '/signin-with-chatgpt?return_to=%2F', signOutUrl: '/signout-with-chatgpt?return_to=%2F' });
    }
    if (path !== '/api/library' && path !== '/api/assets' && !ASSET_PATH.test(path)) return json({ error: 'Не найдено.', code: 'not_found' }, 404);
    const ownerId = requireUser(user);
    if ((path === '/api/library' && ['GET', 'PUT'].includes(request.method)) || (path === '/api/assets' && request.method === 'POST')) requireExpectedAccount(request, ownerId);
    requireDb(db);
    if (path === '/api/library' && request.method === 'GET') {
      const row = await db.prepare('SELECT payload, revision FROM libraries WHERE owner_id = ?').bind(ownerId).first();
      return json(row ? { library: JSON.parse(row.payload), revision: row.revision } : { library: defaultLibrary(), revision: 0 });
    }
    if (path === '/api/library' && request.method === 'PUT') {
      requireSameOrigin(request);
      if (contentType(request) !== 'application/json') throw new ApiError(415, 'Ожидается JSON.', 'unsupported_media_type');
      let input;
      try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(request, JSON_LIMIT))); }
      catch (error) { if (error instanceof ApiError) throw error; invalid('Некорректный JSON.'); }
      if (!object(input) || !Number.isSafeInteger(input.revision) || input.revision < 0) invalid('Некорректная версия коллекции.');
      const library = await normalizeLibrary(input.library, ownerId, db);
      const payload = JSON.stringify(library); const now = Date.now();
      // The revision check and write are one SQL statement; competing clients cannot silently overwrite.
      const row = input.revision === 0
        ? await db.prepare('INSERT INTO libraries (owner_id, payload, revision, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(owner_id) DO NOTHING RETURNING revision').bind(ownerId, payload, now).first()
        : await db.prepare('UPDATE libraries SET payload = ?, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND revision = ? RETURNING revision').bind(payload, now, ownerId, input.revision).first();
      if (!row) throw new ApiError(409, 'Коллекция изменилась в другой вкладке. Обновите данные и повторите.', 'revision_conflict');
      return json({ library, revision: row.revision });
    }
    if (path === '/api/assets' && request.method === 'POST') {
      requireSameOrigin(request); requireBucket(bucket);
      const mime = contentType(request);
      if (!MIMES.has(mime)) throw new ApiError(415, 'Подойдут PNG, JPEG и WebP.', 'unsupported_media_type');
      const bytes = await readBounded(request, IMAGE_LIMIT);
      if (!matchesSignature(bytes, mime)) invalid('Содержимое файла не соответствует формату изображения.');
      const id = crypto.randomUUID(); const key = `${ownerId}/${id}`;
      await bucket.put(key, bytes, { httpMetadata: { contentType: mime } });
      try {
        await db.prepare('INSERT INTO assets (id, owner_id, object_key, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, ownerId, key, mime, bytes.byteLength, Date.now()).run();
      } catch (error) {
        try { if (typeof bucket.delete === 'function') await bucket.delete(key); } catch { /* No private key or database error is exposed. */ }
        throw error;
      }
      return json({ id, image: `/api/assets/${id}` }, 201);
    }
    const asset = path.match(ASSET_PATH);
    if (asset && request.method === 'GET') {
      requireBucket(bucket);
      const row = await db.prepare('SELECT object_key, mime, size FROM assets WHERE id = ? AND owner_id = ?').bind(asset[1], ownerId).first();
      if (!row || !MIMES.has(row.mime)) throw new ApiError(404, 'Изображение не найдено.', 'not_found');
      const stored = await bucket.get(row.object_key);
      if (!stored) throw new ApiError(404, 'Изображение не найдено.', 'not_found');
      return new Response(stored.body, { headers: { ...NO_STORE, 'Content-Type': row.mime, 'Content-Length': String(row.size), 'Content-Disposition': 'inline' } });
    }
    return json({ error: 'Метод не поддерживается.', code: 'method_not_allowed' }, 405);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message, code: error.code }, error.status);
    return json({ error: 'Не удалось выполнить запрос. Попробуйте ещё раз.', code: 'internal_error' }, 500);
  }
}
