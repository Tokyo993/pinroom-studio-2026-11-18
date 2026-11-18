/** Wikimedia Commons adapter. Never inject returned strings as HTML. */
const API_URL = 'https://commons.wikimedia.org/w/api.php';
const IMAGE_HOSTS = new Set(['upload.wikimedia.org', 'thumb.wikimedia.org']);
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 24;

export function plainText(value = '') {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value)
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
      if (entity[0] !== '#') return entities[entity.toLowerCase()] ?? match;
      const hex = entity[1].toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code) : '';
    })
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function allowedUrl(value, allowed) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      !url.port && allowed(url) ? url.href : '';
  } catch { return ''; }
}

export function safeImageUrl(value) {
  return allowedUrl(value, url => IMAGE_HOSTS.has(url.hostname) &&
    url.pathname.startsWith('/wikipedia/commons/') && /\.(jpe?g|png|webp)$/i.test(url.pathname));
}

export function safeSourceUrl(value) {
  return allowedUrl(value, url =>
    (url.hostname === 'commons.wikimedia.org' && url.pathname.startsWith('/wiki/')) ||
    (url.hostname === 'creativecommons.org' && /^\/(licenses|publicdomain)\//.test(url.pathname)));
}

export function normalizePage(page) {
  if (!page || !Number.isSafeInteger(page.pageid) || page.pageid <= 0 ||
      typeof page.title !== 'string' || !/\.(jpe?g|png|webp)$/i.test(page.title)) return null;
  const info = page.imageinfo?.[0];
  if (!info || !Number.isFinite(info.width) || !Number.isFinite(info.height) ||
      info.width <= 0 || info.height <= 0) return null;
  const image = safeImageUrl(info.thumburl || info.url);
  const source = safeSourceUrl(info.descriptionurl);
  if (!image || !source) return null;
  const meta = info.extmetadata ?? {};
  return {
    id: String(page.pageid),
    title: plainText(meta.ObjectName?.value || page.title.replace(/^File:/i, '').replace(/\.(jpe?g|png|webp)$/i, '').replace(/_/g, ' ')).slice(0, 240),
    author: plainText(meta.Artist?.value || 'Wikimedia Commons').slice(0, 180),
    image,
    source,
    license: plainText(meta.LicenseShortName?.value || 'Лицензия на странице источника').slice(0, 100),
    licenseUrl: safeSourceUrl(meta.LicenseUrl?.value),
    width: info.width,
    height: info.height,
  };
}

/** fetchImpl / timeoutMs support deterministic tests; production uses browser fetch. */
export async function searchPins(query, { offset = 0, signal, fetchImpl = globalThis.fetch, timeoutMs = 18000 } = {}) {
  if (signal?.aborted) throw new DOMException('Запрос отменён', 'AbortError');
  const search = String(query || '').trim().slice(0, 180) || 'landscape photography';
  const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const key = `${search.toLowerCase()}:${safeOffset}`;
  const useCache = fetchImpl === globalThis.fetch;
  const cached = useCache && cache.get(key);
  if (cached && Date.now() - cached.time < CACHE_TTL) return structuredClone(cached.result);
  const url = new URL(API_URL);
  url.search = new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: `${search} filetype:bitmap`,
    gsrnamespace: '6', gsrlimit: '24', gsroffset: String(safeOffset),
    prop: 'imageinfo', iiprop: 'url|extmetadata|size', iiurlwidth: '1000',
    format: 'json', origin: '*',
  });
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetchImpl(url.href, { signal: controller.signal, credentials: 'omit' });
    if (!response.ok) {
      if (response.status === 429) throw new Error('Источник временно ограничил запросы. Подождите немного и повторите.');
      throw new Error('Не удалось загрузить изображения. Попробуйте ещё раз.');
    }
    const body = await response.json();
    if (body?.error) throw new Error('Источник не смог выполнить поиск. Измените запрос и попробуйте снова.');
    if (!body || typeof body !== 'object') throw new Error('Источник вернул неожиданный ответ. Повторите поиск.');
    const pages = Object.values(body.query?.pages || {}).sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0));
    const pins = pages.map(normalizePage).filter(Boolean);
    const next = body.continue?.gsroffset;
    const result = { pins, nextOffset: Number.isSafeInteger(next) && next > safeOffset ? next : null };
    if (useCache) {
      if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
      cache.set(key, { time: Date.now(), result });
    }
    return structuredClone(result);
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Запрос отменён', 'AbortError');
    if (timedOut) throw new Error('Источник отвечает слишком долго. Проверьте соединение и повторите.');
    if (error instanceof TypeError) throw new Error('Нет соединения с источником изображений. Проверьте интернет и повторите.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
