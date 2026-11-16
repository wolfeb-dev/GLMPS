#!/usr/bin/env node
// scripts/scut-avatars.mjs
// Generates the SCUT agent profile pictures: a professional set and a Bobiverse
// set, one PNG per agent per mode, plus SCUT's own face and the Slack app icon.
//
//   node scripts/scut-avatars.mjs [outDir]     # default: <repo>/assets/scut
//
// Zero dependencies. The rasterizer is signed-distance based (one evaluation per
// pixel per layer, antialiased over a single pixel of falloff) and the PNG
// encoder is hand-rolled over node:zlib. Nothing here is random at run time: the
// starfield is seeded from the agent id, so the same id always produces the same
// picture and `server/test/scut-avatar-assets.test.js` can prove the committed
// artwork still matches this file.
//
// DESIGN
// The set has to survive being shown at 24-36px in a Slack message list, so each
// avatar is exactly three marks:
//   1. a ground (professional: near-black instrument plate with a hairline
//      frame; Bob: deep space with a starfield and a planet limb),
//   2. the CARRIER RING - an interrupted ring whose gap sits at a different
//      angle for every agent. It is the one mark shared by all 16 avatars, so
//      the set reads as one system, and the gap angle is the agent's signature,
//   3. an APERTURE - one dominant, high-contrast silhouette per agent
//      (disc, square, slit, triangle, bars, lozenge, inverted triangle).
// The silhouette does NOT change between modes: an operator learns one shape per
// station and keeps it when Bob mode is flipped. What changes is the world it
// sits in and the colour it burns at.
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_IDS, SCUT_AVATAR_SLUG } from '../server/lib/scut/bobiverse.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(HERE, '..', 'assets', 'scut');

export const AVATAR_SIZE = 256;
export const APP_ICON_SIZE = 512;
/** Every slug that gets a picture: the agent roster plus SCUT itself. */
export const AVATAR_SLUGS = [...AGENT_IDS, SCUT_AVATAR_SLUG];


const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Encode straight RGBA bytes as a PNG (8-bit, colour type 6, filter 0, no
 * interlace). No tIME chunk, so two runs of this script produce identical files.
 */
export function encodePng(rgba, width, height) {
  const stride = width * 4;
  // Wrap rather than re-read `.buffer` blindly: a pooled Buffer has a non-zero
  // byteOffset, and ignoring it would silently encode someone else's memory.
  const src = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    src.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Decode a PNG written by encodePng back to raw RGBA. Deliberately narrow: it
 * handles exactly the shape this script emits. Tests use it to compare ARTWORK
 * rather than compressed bytes, because deflate output is not guaranteed
 * identical across zlib versions and CI runs more than one Node.
 */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('unsupported PNG variant');
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    if (raw[y * (stride + 1)] !== 0) throw new Error('unsupported PNG row filter');
    raw.copy(rgba, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return { width, height, rgba };
}


function hex(h) {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Every shape returns a SIGNED DISTANCE in unit space (the canvas is 0..1 on
// both axes), negative inside. `cover` turns that into antialiased coverage with
// one pixel of falloff, which is what keeps a 256px render clean at 32px.

const cover = (d, px) => clamp01(0.5 - d / px);

const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
const sdRing = (x, y, cx, cy, r, w) => Math.abs(Math.hypot(x - cx, y - cy) - r) - w / 2;

function sdBox(x, y, cx, cy, hw, hh) {
  const dx = Math.abs(x - cx) - hw;
  const dy = Math.abs(y - cy) - hh;
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
}

/** Equilateral triangle, point up when `up`, inscribed in radius r. */
function sdTriangle(x, y, cx, cy, r, up) {
  const px = x - cx;
  const py = (up ? y - cy : cy - y);
  // Three half-planes: flat base, two slanted sides. max() = convex intersection.
  const base = py - r * 0.5;
  const left = -0.866 * px - 0.5 * py - r * 0.5;
  const right = 0.866 * px - 0.5 * py - r * 0.5;
  return Math.max(base, left, right);
}

/** Rounded box, used for the "speech aperture" lozenge. */
const sdRoundBox = (x, y, cx, cy, hw, hh, rad) => sdBox(x, y, cx, cy, hw - rad, hh - rad) - rad;

/**
 * An interrupted ring: the carrier. `gapDeg` wide, centred on `atDeg`
 * (0 = pointing right, angles run clockwise on screen).
 */
function sdArcRing(x, y, cx, cy, r, w, atDeg, gapDeg) {
  const ring = sdRing(x, y, cx, cy, r, w);
  const a = (Math.atan2(y - cy, x - cx) * 180) / Math.PI;
  const delta = Math.abs(((a - atDeg + 540) % 360) - 180); // angular distance to the gap centre
  // Positive inside the gap, so max() subtracts that wedge from the ring.
  // Expressed as an arc LENGTH, not an angle, so the cut antialiases at the same
  // rate as every other edge in the image.
  const cut = (((gapDeg / 2 - delta) * Math.PI) / 180) * r;
  return Math.max(ring, cut);
}

// Professional accents stay inside the GLMPS house palette
// (web/styles.css) so SCUT looks like the product it belongs to. Rust
// (--destructive) is too dark to read at 32px, so the critic uses #e05656, the
// lighter red styles.css already established for legibility.
const PRO_ACCENT = {
  riker:    '#0fa4af', // bright cyan - the carrier itself
  bill:     '#e0a23a', // amber
  garfield: '#afdde5', // icy pale cyan
  mario:    '#3fbf9f', // sea green
  homer:    '#8a7ff0', // violet - research is the one lane that is not operations
  guppy:    '#5aa9e6', // soft blue
  medeiros: '#e05656', // the legible red
  scut:     '#0fa4af',
};

// Bob accents run hotter: these are probes burning in vacuum, not instruments on
// a rack. Medeiros gets a harder red - he is the antagonist, and the picture
// should say so before the name does.
const BOB_ACCENT = {
  riker:    '#ffd166',
  bill:     '#ff8c42',
  garfield: '#7ee0c0',
  mario:    '#ff5f7e',
  homer:    '#b388ff',
  guppy:    '#56d0f0',
  medeiros: '#ff3b3b',
  scut:     '#7fe9ff',
};

const PRO_GROUND_IN = hex('#0d2b2e');  // deep teal, lit from the centre
const PRO_GROUND_OUT = hex('#07090b'); // near-black void
const BOB_GROUND_IN = hex('#141b3d');  // deep space, lit from above
const BOB_GROUND_OUT = hex('#04050d');

// One dominant silhouette per agent, sized as a fraction of the canvas. These
// are the shapes an operator actually recognizes at message size, so they are
// deliberately far apart from each other: disc, square, slit, up, bars, lozenge,
// down, ringed disc.
const APERTURE = {
  // Lead / Riker - the open aperture.
  riker: (x, y) => sdCircle(x, y, 0.5, 0.5, 0.175),
  // Builder / Bill - a solid module.
  bill: (x, y) => sdBox(x, y, 0.5, 0.5, 0.15, 0.15),
  // Reviewer / Garfield - a lens stopped down to a slit.
  garfield: (x, y) => Math.max(sdCircle(x, y, 0.5, 0.5, 0.175), -sdBox(x, y, 0.5, 0.5, 0.21, 0.038)),
  // Scout / Mario - a prow.
  mario: (x, y) => sdTriangle(x, y, 0.5, 0.5, 0.21, true),
  // Researcher / Homer - a two-band spectrum.
  homer: (x, y) => Math.min(sdBox(x, y, 0.5, 0.410, 0.17, 0.042), sdBox(x, y, 0.5, 0.590, 0.17, 0.042)),
  // Assistant / Guppy - a speech aperture.
  guppy: (x, y) => sdRoundBox(x, y, 0.5, 0.5, 0.185, 0.12, 0.105),
  // Critic / Medeiros - the prow inverted: the same shape, pointed the wrong way.
  medeiros: (x, y) => sdTriangle(x, y, 0.5, 0.5, 0.21, false),
  // SCUT itself - a disc inside a CLOSED carrier. Every agent's ring has a gap;
  // the transceiver's does not.
  scut: (x, y) => Math.min(sdCircle(x, y, 0.5, 0.5, 0.115), sdRing(x, y, 0.5, 0.5, 0.205, 0.05)),
};

// The carrier gap angle is the agent's signature. Spread across the circle by a
// step that is coprime with 360 so no two land close together.
const GAP_AT = Object.fromEntries(AVATAR_SLUGS.map((id, i) => [id, (i * 47 + 25) % 360]));


function hash32(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic star positions for one agent: [x, y, radius, brightness]. */
function starsFor(id, count = 34) {
  const rnd = mulberry32(hash32(`scut-stars:${id}`));
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push([rnd(), rnd() * 0.78, 0.004 + rnd() * 0.006, 0.30 + rnd() * 0.65]);
  }
  return out;
}


/**
 * Render one avatar to raw RGBA bytes.
 * @param {{id:string, mode:'pro'|'bob', size?:number}} opts
 * @returns {{width:number, height:number, rgba:Buffer}}
 */
export function renderAvatar({ id, mode, size = AVATAR_SIZE }) {
  if (!APERTURE[id]) throw new Error(`no aperture defined for agent "${id}"`);
  if (mode !== 'pro' && mode !== 'bob') throw new Error(`unknown mode "${mode}"`);

  const bob = mode === 'bob';
  const accent = hex((bob ? BOB_ACCENT : PRO_ACCENT)[id]);
  const groundIn = bob ? BOB_GROUND_IN : PRO_GROUND_IN;
  const groundOut = bob ? BOB_GROUND_OUT : PRO_GROUND_OUT;
  const aperture = APERTURE[id];
  const gapAt = GAP_AT[id];
  // SCUT's aperture is already a closed ring, so it does not also wear a carrier.
  const carrier = id !== SCUT_AVATAR_SLUG;
  const stars = bob ? starsFor(id) : [];
  // The planet limb: a world filling the bottom edge, dark, with the accent
  // glowing along its terminator. Kept LOW and FLAT on purpose - a smaller,
  // higher world reads as a second ring competing with the carrier instead of
  // as a horizon.
  const limb = { cx: 0.5, cy: 1.46, r: 0.70 };
  const limbBody = mix(groundOut, accent, 0.16);

  const px = 1 / size;
  const rgba = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py += 1) {
    for (let pxi = 0; pxi < size; pxi += 1) {
      const x = (pxi + 0.5) / size;
      const y = (py + 0.5) / size;

      // 1. ground: a soft radial lift so the plate is not a flat rectangle.
      const fromCentre = Math.hypot(x - 0.5, y - (bob ? 0.34 : 0.5));
      let col = mix(groundIn, groundOut, clamp01(fromCentre / 0.72));

      if (bob) {
        // 2a. starfield, behind everything else in the sky.
        for (const [sx, sy, sr, sb] of stars) {
          const a = cover(sdCircle(x, y, sx, sy, sr), px) * sb;
          if (a > 0) col = mix(col, [214, 236, 255], a);
        }
        // 2b. the world, and the light along its edge.
        const dLimb = sdCircle(x, y, limb.cx, limb.cy, limb.r);
        const inLimb = cover(dLimb, px);
        if (inLimb > 0) col = mix(col, limbBody, inLimb);
        const rim = cover(Math.abs(dLimb) - 0.005, px);
        if (rim > 0) col = mix(col, accent, rim * 0.5);
      } else {
        // 2. instrument frame: a hairline inset that defines the plate.
        const frame = cover(Math.abs(sdBox(x, y, 0.5, 0.5, 0.455, 0.455)) - 0.004, px);
        if (frame > 0) col = mix(col, accent, frame * 0.16);
      }

      // 3. the carrier ring - the mark every avatar in the set shares.
      if (carrier) {
        const a = cover(sdArcRing(x, y, 0.5, 0.5, 0.375, 0.048, gapAt, 72), px);
        if (a > 0) col = mix(col, accent, a * (bob ? 0.92 : 0.72));
      }

      // 4. the aperture. In Bob mode it burns: a radial bloom behind it reads as
      // emission without a blur pass. The bloom is deliberately RADIAL rather
      // than shaped by the aperture's own distance field - a convex polygon's
      // half-plane distance grows too slowly past its apex, which turns a shaped
      // glow on the triangles into a visible cone.
      const dAp = aperture(x, y);
      if (bob) {
        const t = clamp01(1 - Math.hypot(x - 0.5, y - 0.5) / 0.30);
        const glow = t * t * 0.34;
        if (glow > 0) col = mix(col, accent, glow);
      }
      const a = cover(dAp, px);
      if (a > 0) col = mix(col, bob ? mix(accent, [255, 255, 255], 0.22) : accent, a);

      const o = (py * size + pxi) * 4;
      rgba[o] = Math.round(clamp01(col[0] / 255) * 255);
      rgba[o + 1] = Math.round(clamp01(col[1] / 255) * 255);
      rgba[o + 2] = Math.round(clamp01(col[2] / 255) * 255);
      rgba[o + 3] = 255;
    }
  }
  return { width: size, height: size, rgba };
}

/** The Slack app icon: SCUT's own face at app-icon scale. */
export function renderAppIcon(size = APP_ICON_SIZE) {
  return renderAvatar({ id: SCUT_AVATAR_SLUG, mode: 'pro', size });
}

/**
 * Write the whole set under `outDir`. Returns the relative paths written, in a
 * stable order, so a caller can diff them against what is committed.
 */
export function writeAll(outDir = DEFAULT_OUT) {
  const written = [];
  for (const mode of ['pro', 'bob']) {
    mkdirSync(join(outDir, mode), { recursive: true });
    for (const id of AVATAR_SLUGS) {
      const { width, height, rgba } = renderAvatar({ id, mode });
      const rel = `${mode}/${id}.png`;
      writeFileSync(join(outDir, mode, `${id}.png`), encodePng(rgba, width, height));
      written.push(rel);
    }
  }
  const icon = renderAppIcon();
  writeFileSync(join(outDir, 'app-icon.png'), encodePng(icon.rgba, icon.width, icon.height));
  written.push('app-icon.png');
  return written;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const outDir = process.argv[2] ? process.argv[2] : DEFAULT_OUT;
  const written = writeAll(outDir);
  console.log(`wrote ${written.length} files to ${outDir}`);
  for (const rel of written) console.log(`  ${rel}`);
}
