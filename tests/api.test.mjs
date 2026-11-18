import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePage, plainText, safeImageUrl, safeSourceUrl, searchPins } from '../dist/api.js';

function page(id = 101, overrides = {}) {
  return { pageid: id, title: 'File:Mountain_view.jpg', index: 1, imageinfo: [{
    width: 2000, height: 3000,
    thumburl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Mountain.jpg/960px-Mountain.jpg',
    descriptionurl: 'https://commons.wikimedia.org/wiki/File:Mountain_view.jpg',
    extmetadata: { Artist: { value: '<a href="https://example.org">Alice &amp; Bob</a>' },
      LicenseShortName: { value: 'CC BY-SA 4.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' } },
  }], ...overrides };
}
const response = body => async () => ({ ok: true, json: async () => body });

test('normalizes API data while preserving attribution and original dimensions', () => {
  const pin = normalizePage(page());
  assert.equal(pin.title, 'Mountain view');
  assert.equal(pin.author, 'Alice & Bob');
  assert.equal(pin.id, '101');
  assert.equal(pin.license, 'CC BY-SA 4.0');
  assert.equal(pin.width, 2000);
  assert.equal(pin.height, 3000);
});

test('metadata is text, including encoded markup and hostile script bodies', () => {
  assert.equal(plainText('&lt;b&gt;Hello&lt;/b&gt; <script>alert(1)</script> &#x1f331;'), 'Hello 🌱');
  assert.equal(plainText('A&#0;&#99999999;&#xD800;B'), 'AB');
  const p = page();
  p.imageinfo[0].extmetadata.Artist.value = '<img src=x onerror=alert(1)>Artist';
  assert.equal(normalizePage(p).author, 'Artist');
});

test('image allowlist rejects script schemes, credentials, lookalike hosts, SVG and foreign domains', () => {
  for (const url of ['javascript:alert(1)', 'data:image/png;base64,test', 'https://upload.wikimedia.org.evil.test/wikipedia/commons/a.jpg',
    'https://me:secret@upload.wikimedia.org/wikipedia/commons/a.jpg', 'http://upload.wikimedia.org/wikipedia/commons/a.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/a.svg', 'https://evil.test/a.jpg', 'https://upload.wikimedia.org:444/wikipedia/commons/a.jpg']) {
    assert.equal(safeImageUrl(url), '', url);
  }
  assert.ok(safeImageUrl('https://upload.wikimedia.org/wikipedia/commons/a/ab/Picture.png'));
});

test('source links only allow Commons descriptions and Creative Commons licenses', () => {
  assert.equal(safeSourceUrl('https://commons.wikimedia.org.evil.test/wiki/File:X.jpg'), '');
  assert.equal(safeSourceUrl('https://commons.wikimedia.org/w/api.php'), '');
  assert.ok(safeSourceUrl('https://creativecommons.org/publicdomain/zero/1.0/'));
});

test('drops missing, non-bitmap, untrusted and dimensionless images', () => {
  for (const p of [null, {}, page(1, { imageinfo: [] }), page(1, { title: 'File:Drawing.svg' }), page(-1)]) assert.equal(normalizePage(p), null);
  const p = page(); p.imageinfo[0].width = 0;
  assert.equal(normalizePage(p), null);
  p.imageinfo[0].width = 100; p.imageinfo[0].thumburl = 'https://evil.test/img.jpg';
  assert.equal(normalizePage(p), null);
});

test('search sends encoded query and offset, omits credentials and respects source result order', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url: new URL(url), options };
    return { ok: true, json: async () => ({ query: { pages: { a: page(2, { index: 2 }), b: page(1, { index: 1 }) } }, continue: { gsroffset: 48 } }) };
  };
  const result = await searchPins('sea & sky', { offset: 24, fetchImpl });
  assert.equal(captured.url.searchParams.get('gsrsearch'), 'sea & sky filetype:bitmap');
  assert.equal(captured.url.searchParams.get('gsroffset'), '24');
  assert.equal(captured.options.credentials, 'omit');
  assert.deepEqual(result.pins.map(p => p.id), ['1', '2']);
  assert.equal(result.nextOffset, 48);
});

test('empty results are valid; non-progressing pagination terminates', async () => {
  assert.deepEqual(await searchPins('none', { fetchImpl: response({ batchcomplete: '' }) }), { pins: [], nextOffset: null });
  assert.equal((await searchPins('none', { offset: 24, fetchImpl: response({ continue: { gsroffset: 24 } }) })).nextOffset, null);
});

test('rate limit and API failures become actionable messages', async () => {
  await assert.rejects(searchPins('x', { fetchImpl: async () => ({ ok: false, status: 429 }) }), /ограничил запросы/);
  await assert.rejects(searchPins('x', { fetchImpl: response({ error: { code: 'badvalue', info: '<sensitive>' } }) }), /Измените запрос/);
  await assert.rejects(searchPins('x', { fetchImpl: async () => { throw new TypeError('fetch failed'); } }), /Проверьте интернет/);
});

test('already-cancelled searches never reach the network', async () => {
  const controller = new AbortController(); controller.abort();
  let called = false;
  await assert.rejects(searchPins('x', { signal: controller.signal, fetchImpl: async () => { called = true; } }), { name: 'AbortError' });
  assert.equal(called, false);
});

test('cancellation propagates to an in-flight request', async () => {
  const controller = new AbortController();
  const request = searchPins('x', { signal: controller.signal, fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }) });
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
});

test('timeouts return a retryable message and abort the underlying request', async () => {
  let aborted = false;
  await assert.rejects(searchPins('x', { timeoutMs: 5, fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); });
  }) }), /слишком долго/);
  assert.equal(aborted, true);
});
