import test from 'node:test';
import assert from 'node:assert/strict';
import { initialEdit, sanitizeEdit, cropRect, outputSize, canvasFilter, createHistory } from '../dist/editor-core.js';

test('defaults are independent, complete, and preserved by sanitization', () => {
  assert.deepEqual(sanitizeEdit(), initialEdit());
  const first = initialEdit();
  first.text = 'Changed';
  assert.equal(initialEdit().text, '');
  assert.deepEqual(sanitizeEdit(null), initialEdit());
});

test('untrusted settings are normalized, bounded, and cannot inject CSS', () => {
  const state = sanitizeEdit({ rotation: -90, flip: 'false', ratio: '__proto__', zoom: 9,
    panX: -5, panY: 300, brightness: '140', contrast: Infinity, saturation: -20,
    textX: NaN, textY: null, textSize: 100, textColor: '#ffffff;url(x)',
    filter: 'blur(99px)', text: '🧑'.repeat(130), unknown: 'ignored' });
  assert.equal(state.rotation, 270);
  assert.equal(state.flip, false);
  assert.equal(state.ratio, 'original');
  assert.equal(state.zoom, 3);
  assert.equal(state.panX, 0);
  assert.equal(state.panY, 100);
  assert.equal(state.brightness, 140);
  assert.equal(state.contrast, 100);
  assert.equal(state.saturation, 0);
  assert.equal(state.textX, 50);
  assert.equal(state.textY, 75);
  assert.equal(state.textSize, 18);
  assert.equal(state.textColor, '#ffffff');
  assert.equal(state.filter, 'none');
  assert.equal(Array.from(state.text).length, 120);
  assert.equal('unknown' in state, false);
});

test('original crop preserves source and square crop centers without distortion', () => {
  assert.deepEqual(cropRect(1200, 800, initialEdit()), { sx: 0, sy: 0, sw: 1200, sh: 800 });
  assert.deepEqual(cropRect(1200, 800, { ratio: '1:1' }), { sx: 200, sy: 0, sw: 800, sh: 800 });
  assert.deepEqual(cropRect(800, 1200, { ratio: '1:1' }), { sx: 0, sy: 200, sw: 800, sh: 800 });
});

test('crop pan reaches boundaries, zoom respects ratio, rotation does not change source crop', () => {
  const input = { ratio: '4:5', zoom: 2, panX: 100, panY: 0 };
  const rect = cropRect(1600, 1000, input);
  assert.deepEqual(rect, { sx: 1200, sy: 0, sw: 400, sh: 500 });
  assert.deepEqual(cropRect(1600, 1000, { ...input, rotation: 90 }), rect);
  const bottom = cropRect(1600, 1000, { ...input, panX: 0, panY: 100 });
  assert.equal(bottom.sy + bottom.sh, 1000);
});

test('all crop ratios and pan extremes stay inside tiny and huge images', () => {
  for (const [w, h] of [[1, 1], [1, 10000], [10000, 1], [1e9, 7e8]]) {
    for (const ratio of ['original', '1:1', '4:5', '9:16', '16:9']) {
      for (const pan of [0, 50, 100]) {
        const r = cropRect(w, h, { ratio, panX: pan, panY: pan, zoom: 3 });
        assert.ok(r.sx >= 0 && r.sy >= 0 && r.sw > 0 && r.sh > 0);
        assert.ok(r.sx + r.sw <= w + 1e-6);
        assert.ok(r.sy + r.sh <= h + 1e-6);
      }
    }
  }
});

test('invalid source dimensions fail explicitly rather than producing NaN canvases', () => {
  for (const bad of [0, -1, Infinity, NaN, '100', null]) {
    assert.throws(() => cropRect(bad, 100), RangeError);
    assert.throws(() => cropRect(100, bad), RangeError);
    assert.throws(() => outputSize(bad, 100), RangeError);
  }
  assert.throws(() => outputSize(100, 100, 0, 0), RangeError);
});

test('export resolution swaps quarter-turn dimensions and never upscales', () => {
  assert.deepEqual(outputSize(4000, 2000, 0), { width: 1600, height: 800 });
  assert.deepEqual(outputSize(4000, 2000, 90), { width: 800, height: 1600 });
  assert.deepEqual(outputSize(4000, 2000, -90), { width: 800, height: 1600 });
  assert.deepEqual(outputSize(600, 400, 180), { width: 600, height: 400 });
  assert.deepEqual(outputSize(1, 10000, 0), { width: 1, height: 1600 });
  assert.deepEqual(outputSize(5, 3, 450, 2), { width: 1, height: 2 });
});

test('filters compose bounded adjustments with the selected effect', () => {
  assert.equal(canvasFilter({ brightness: 125, contrast: 110, saturation: 80, filter: 'warm' }),
    'brightness(125%) contrast(110%) saturate(80%) sepia(0.25) saturate(1.15)');
  assert.match(canvasFilter({ filter: 'mono' }), /grayscale\(1\)$/);
  assert.match(canvasFilter({ filter: 'cool' }), /hue-rotate\(12deg\)$/);
  assert.match(canvasFilter({ filter: 'sepia' }), /sepia\(0.8\)$/);
});

test('undo/redo safely reaches boundaries, ignores duplicates, and clears branched future', () => {
  const history = createHistory({ value: 0 });
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
  assert.deepEqual(history.undo(), { value: 0 });
  history.push({ value: 1 });
  history.push({ value: 1 });
  history.push({ value: 2 });
  assert.deepEqual(history.undo(), { value: 1 });
  assert.equal(history.canRedo, true);
  assert.deepEqual(history.redo(), { value: 2 });
  history.undo();
  history.push({ value: 3 });
  assert.equal(history.canRedo, false);
  assert.deepEqual(history.redo(), { value: 3 });
  history.undo();
  assert.deepEqual(history.undo(), { value: 0 });
  assert.equal(history.canUndo, false);
});

test('history snapshots remain immutable across external reads and writes', () => {
  const input = { nested: { value: 0 } };
  const history = createHistory(input);
  input.nested.value = 99;
  assert.equal(history.current.nested.value, 0);
  const next = { nested: { value: 1 } };
  const returned = history.push(next);
  next.nested.value = 5;
  returned.nested.value = 6;
  const read = history.current;
  read.nested.value = 7;
  assert.equal(history.current.nested.value, 1);
  const prior = history.undo();
  prior.nested.value = 20;
  assert.equal(history.current.nested.value, 0);
});

test('history retains the latest forty states to bound memory', () => {
  const history = createHistory({ n: 0 });
  for (let n = 1; n <= 75; n++) history.push({ n });
  let count = 0;
  while (history.canUndo) { history.undo(); count++; }
  assert.equal(count, 39);
  assert.equal(history.current.n, 36);
});
