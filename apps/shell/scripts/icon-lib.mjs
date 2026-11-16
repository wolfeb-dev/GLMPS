// The GLMPS mark (web/favicon.svg geometry, D25 palette) rasterized in pure
// Node: supersampled coverage per layer, straight-alpha RGBA, PNG and
// DIB encoders and the ICO container (DIB below 256, PNG at 256, the layout
// every Windows icon loader accepts). No image packages (zero-dependency rule).
import zlib from 'node:zlib';

export const PALETTE = Object.freeze({
  ground: [0x0a, 0x0b, 0x0d], pale: [0xaf, 0xdd, 0xe5], cyan: [0x0f, 0xa4, 0xaf],
  amber: [0xe0, 0xa2, 0x3a], rust: [0x96, 0x47, 0x34],
});
export const APP_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];
export const TRAY_ICON_SIZES = [16, 20, 24, 32, 40, 48];

// favicon.svg: M 146 126 A 50 50 0 1 1 146 74 (large arc, sweep 1).
const ARC_CX = 146 - Math.sqrt(50 * 50 - 26 * 26);
const ARC_CY = 100;
const ARC_R = 50;
const ARC_GAP = Math.atan2(26, 146 - ARC_CX); // the open side of the G, about 31.3 degrees

function distArc(x, y) {
  const dx = x - ARC_CX;
  const dy = y - ARC_CY;
  if (Math.abs(Math.atan2(dy, dx)) >= ARC_GAP) return Math.abs(Math.hypot(dx, dy) - ARC_R);
  return Math.min(Math.hypot(x - 146, y - 126), Math.hypot(x - 146, y - 74)); // round caps
}
function distSeg(x, y, x1, y1, x2, y2) {
  const t = Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / ((x2 - x1) ** 2 + (y2 - y1) ** 2)));
  return Math.hypot(x - (x1 + t * (x2 - x1)), y - (y1 + t * (y2 - y1)));
}
const dist = (x, y, cx, cy) => Math.hypot(x - cx, y - cy);

export function markLayers(state = 'app') {
  const dim = state === 'down' ? 0.45 : 1;
  const layers = [
    { color: PALETTE.ground, alpha: 1, hit: (x, y) => dist(x, y, 100, 100) <= 94 },
  ];
  // Light ring on the outer edge so the dark disc reads on a dark taskbar; tray states keep the plain disc.
  if (state === 'app') layers.push({ color: PALETTE.pale, alpha: 0.95, hit: (x, y) => { const d = dist(x, y, 100, 100); return d >= 88 && d <= 94; } });
  layers.push(
    { color: PALETTE.pale, alpha: 0.28, hit: (x, y) => Math.abs(dist(x, y, 100, 100) - 78) <= 2 },
    { color: PALETTE.pale, alpha: 0.92 * dim, hit: (x, y) => distArc(x, y) <= 9 },
    { color: PALETTE.cyan, alpha: dim, hit: (x, y) => distSeg(x, y, 112, 100, 146, 100) <= 9 },
  );
  if (state === 'degraded' || state === 'down') layers.push({ color: PALETTE.ground, alpha: 1, hit: (x, y) => dist(x, y, 158, 158) <= 40 });
  if (state === 'degraded') layers.push({ color: PALETTE.amber, alpha: 1, hit: (x, y) => dist(x, y, 158, 158) <= 30 });
  if (state === 'down') layers.push({ color: PALETTE.rust, alpha: 1, hit: (x, y) => { const d = dist(x, y, 158, 158); return d >= 18 && d <= 30; } });
  return layers;
}

export function renderMark({ size, state = 'app', samples = 4 }) {
  const layers = markLayers(state);
  const rgba = Buffer.alloc(size * size * 4);
  const scale = 200 / size;
  const n = samples * samples;
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (pxl + (sx + 0.5) / samples) * scale;
          const y = (py + (sy + 0.5) / samples) * scale;
          let cr = 0; let cg = 0; let cb = 0; let ca = 0; // premultiplied "over"
          for (const l of layers) {
            if (!l.hit(x, y)) continue;
            cr = l.color[0] * l.alpha + cr * (1 - l.alpha);
            cg = l.color[1] * l.alpha + cg * (1 - l.alpha);
            cb = l.color[2] * l.alpha + cb * (1 - l.alpha);
            ca = l.alpha + ca * (1 - l.alpha);
          }
          r += cr; g += cg; b += cb; a += ca;
        }
      }
      const o = (py * size + pxl) * 4;
      const A = a / n;
      const un = (v) => (A ? Math.min(255, Math.round(v / n / A)) : 0);
      rgba[o] = un(r); rgba[o + 1] = un(g); rgba[o + 2] = un(b); rgba[o + 3] = Math.round(A * 255);
    }
  }
  return rgba;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA, no interlace
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) { raw[y * stride] = 0; rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4); }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function encodeDib(rgba, size) {
  const maskStride = Math.ceil(size / 32) * 4;
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0); head.writeInt32LE(size, 4); head.writeInt32LE(size * 2, 8); // height covers XOR bitmap plus AND mask
  head.writeUInt16LE(1, 12); head.writeUInt16LE(32, 14);
  const xor = Buffer.alloc(size * size * 4);
  const mask = Buffer.alloc(maskStride * size);
  for (let y = 0; y < size; y++) {
    const dstRow = size - 1 - y; // rows are stored bottom-up
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const o = (dstRow * size + x) * 4;
      xor[o] = rgba[s + 2]; xor[o + 1] = rgba[s + 1]; xor[o + 2] = rgba[s]; xor[o + 3] = rgba[s + 3];
      if (rgba[s + 3] === 0) mask[dstRow * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([head, xor, mask]);
}

export function encodeIco(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([head, ...entries, ...images.map((p) => p.data)]);
}

const ico = (sizes, state) => encodeIco(sizes.map((size) => {
  const rgba = renderMark({ size, state });
  return { size, data: size >= 256 ? encodePng(rgba, size) : encodeDib(rgba, size) };
}));

export function buildIcons() {
  const app = ico(APP_ICON_SIZES, 'app');
  return {
    'build/icon.ico': app,
    'build/icon.png': encodePng(renderMark({ size: 256 }), 256),
    'assets/icon.ico': app,
    'assets/tray-up.ico': ico(TRAY_ICON_SIZES, 'up'),
    'assets/tray-degraded.ico': ico(TRAY_ICON_SIZES, 'degraded'),
    'assets/tray-down.ico': ico(TRAY_ICON_SIZES, 'down'),
  };
}
