/** Pure, dependency-free image editing geometry and undo history. */
const RATIOS = new Map([['original', null], ['1:1', 1], ['4:5', 4 / 5], ['9:16', 9 / 16], ['16:9', 16 / 9]]);
const FILTERS = new Set(['none', 'warm', 'cool', 'mono', 'sepia']);

export function initialEdit() {
  return {
    rotation: 0, flip: false, ratio: 'original', zoom: 1,
    panX: 50, panY: 50, brightness: 100, contrast: 100, saturation: 100,
    filter: 'none', text: '', textX: 50, textY: 75, textSize: 9, textColor: '#ffffff',
  };
}

function finite(value, fallback) {
  if (typeof value !== 'number' && typeof value !== 'string') return fallback;
  if (typeof value === 'string' && !value.trim()) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, low, high, fallback) {
  return Math.min(high, Math.max(low, finite(value, fallback)));
}

function quarterTurn(value) {
  const normalized = ((finite(value, 0) % 360) + 360) % 360;
  return (Math.round(normalized / 90) * 90) % 360;
}

export function sanitizeEdit(input = {}) {
  const state = input && typeof input === 'object' ? input : {};
  return {
    rotation: quarterTurn(state.rotation),
    flip: state.flip === true,
    ratio: RATIOS.has(state.ratio) ? state.ratio : 'original',
    zoom: clamp(state.zoom, 1, 3, 1),
    panX: clamp(state.panX, 0, 100, 50),
    panY: clamp(state.panY, 0, 100, 50),
    brightness: clamp(state.brightness, 0, 200, 100),
    contrast: clamp(state.contrast, 0, 200, 100),
    saturation: clamp(state.saturation, 0, 200, 100),
    filter: FILTERS.has(state.filter) ? state.filter : 'none',
    text: typeof state.text === 'string' ? Array.from(state.text).slice(0, 120).join('') : '',
    textX: clamp(state.textX, 0, 100, 50),
    textY: clamp(state.textY, 0, 100, 75),
    textSize: clamp(state.textSize, 3, 18, 9),
    textColor: typeof state.textColor === 'string' && /^#[0-9a-f]{6}$/i.test(state.textColor) ? state.textColor.toLowerCase() : '#ffffff',
  };
}

function dimension(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
  return value;
}

/** Crop in source-image coordinates. Rotation is applied after cropping. */
export function cropRect(imageWidth, imageHeight, input) {
  const width = dimension(imageWidth, 'imageWidth');
  const height = dimension(imageHeight, 'imageHeight');
  const state = sanitizeEdit(input);
  const ratio = RATIOS.get(state.ratio);
  let sw = width;
  let sh = height;
  if (ratio !== null) {
    if (width / height > ratio) sw = height * ratio;
    else sh = width / ratio;
  }
  sw /= state.zoom;
  sh /= state.zoom;
  return {
    sx: Math.max(0, width - sw) * (state.panX / 100),
    sy: Math.max(0, height - sh) * (state.panY / 100),
    sw,
    sh,
  };
}

/** Rounded canvas dimensions, downscaled only, with at least one pixel per side. */
export function outputSize(sw, sh, rotation = 0, maxEdge = 1600) {
  let width = dimension(sw, 'sw');
  let height = dimension(sh, 'sh');
  const edge = Math.max(1, Math.floor(dimension(maxEdge, 'maxEdge')));
  if (quarterTurn(rotation) % 180) [width, height] = [height, width];
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function canvasFilter(input) {
  const state = sanitizeEdit(input);
  const effect = {
    none: '', warm: ' sepia(0.25) saturate(1.15)', cool: ' hue-rotate(12deg)',
    mono: ' grayscale(1)', sepia: ' sepia(0.8)',
  }[state.filter];
  return `brightness(${state.brightness}%) contrast(${state.contrast}%) saturate(${state.saturation}%)${effect}`;
}

/** Snapshots are private and cloned on both write and read. Forty states are retained. */
export function createHistory(initial) {
  const clone = (value) => structuredClone(value);
  let states = [clone(initial)];
  let index = 0;
  return {
    get current() { return clone(states[index]); },
    get canUndo() { return index > 0; },
    get canRedo() { return index < states.length - 1; },
    push(next) {
      const snapshot = clone(next);
      if (JSON.stringify(snapshot) === JSON.stringify(states[index])) return clone(states[index]);
      states = states.slice(0, index + 1);
      states.push(snapshot);
      if (states.length > 40) states.shift();
      index = states.length - 1;
      return clone(states[index]);
    },
    undo() { if (index > 0) index -= 1; return clone(states[index]); },
    redo() { if (index < states.length - 1) index += 1; return clone(states[index]); },
  };
}
