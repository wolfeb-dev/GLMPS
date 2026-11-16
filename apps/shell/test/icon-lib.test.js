import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PALETTE, renderMark, encodePng, encodeDib, encodeIco, buildIcons, APP_ICON_SIZES, TRAY_ICON_SIZES } from '../scripts/icon-lib.mjs';

const px = (rgba, size, x, y) => { const o = (y * size + x) * 4; return [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]]; };
const SIZE = 64; // one pixel = 3.125 mark units

test('outside the disc is transparent; the ground disc is opaque #0a0b0d', () => {
  const rgba = renderMark({ size: SIZE });
  assert.equal(px(rgba, SIZE, 0, 0)[3], 0);
  assert.deepEqual(px(rgba, SIZE, 32, 12), [...PALETTE.ground, 255]); // mark (100, 40): inside the disc, off the ring and the G
});

test('the G bar is cyan and the G arc is pale', () => {
  const rgba = renderMark({ size: SIZE });
  assert.deepEqual(px(rgba, SIZE, 41, 32), [...PALETTE.cyan, 255]);   // mark (130, 101): on the bar
  const [r, g, b, a] = px(rgba, SIZE, 17, 32);                         // mark (54, 101): the arc's left edge
  assert.equal(a, 255);
  assert.ok(r > 150 && g > 190 && b > 200, `pale arc, got ${[r, g, b]}`);
});

test('tray states differ by shape at the lower right: none, solid amber dot, hollow rust ring', () => {
  const at = (state, x, y) => px(renderMark({ size: SIZE, state }), SIZE, x, y);
  assert.deepEqual(at('up', 50, 50), [...PALETTE.ground, 255]);        // mark (158, 158)
  assert.deepEqual(at('degraded', 50, 50), [...PALETTE.amber, 255]);
  assert.deepEqual(at('down', 50, 50), [...PALETTE.ground, 255]);      // the hole of the ring
  assert.deepEqual(at('down', 58, 50), [...PALETTE.rust, 255]);        // mark (182, 158): on the ring
  assert.ok(at('down', 41, 32)[1] < at('up', 41, 32)[1], 'the G is dimmed when down');
});

function chunks(png) {
  const out = [];
  for (let o = 8; o < png.length;) {
    const len = png.readUInt32BE(o);
    out.push({ type: png.toString('ascii', o + 4, o + 8), data: png.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
  }
  return out;
}

test('encodePng writes a valid RGBA PNG that decodes back to the same pixels', () => {
  const rgba = renderMark({ size: 16 });
  const png = encodePng(rgba, 16);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const c = chunks(png);
  assert.deepEqual(c.map((x) => x.type), ['IHDR', 'IDAT', 'IEND']);
  assert.equal(c[0].data.readUInt32BE(0), 16);
  assert.equal(c[0].data[9], 6); // colour type RGBA
  assert.deepEqual([...png.subarray(png.length - 4)], [0xae, 0x42, 0x60, 0x82]); // the fixed IEND CRC
  const raw = zlib.inflateSync(c[1].data);
  assert.equal(raw.length, (16 * 4 + 1) * 16);
  assert.equal(raw[0], 0);
  assert.deepEqual(raw.subarray(1, 65), rgba.subarray(0, 64));
});

test('the app mark has a light ring at the outer edge; tray states do not', () => {
  const edge = (state) => px(renderMark({ size: SIZE, state }), SIZE, 2, 32); // mark (7.8, 101): radius about 92
  const [r, g, b, a] = edge('app');
  assert.equal(a, 255);
  assert.ok(r > 130 && g > 170 && b > 180, `light ring, got ${[r, g, b]}`);
  assert.deepEqual(edge('up'), [...PALETTE.ground, 255]);
  assert.deepEqual(edge('down'), [...PALETTE.ground, 255]);
});

test('encodeDib writes a 32-bit bottom-up BGRA DIB with a 1-bpp AND mask', () => {
  const size = 16;
  const rgba = Buffer.alloc(size * size * 4, 255); // opaque white except the two set pixels
  rgba.set([10, 20, 30, 255], 0); // top-left pixel
  rgba.set([40, 50, 60, 0], (size * size - 1) * 4); // bottom-right pixel, transparent
  const dib = encodeDib(rgba, size);
  assert.equal(dib.readUInt32LE(0), 40);
  assert.equal(dib.readInt32LE(4), size);
  assert.equal(dib.readInt32LE(8), size * 2); // height is doubled: XOR bitmap plus AND mask
  assert.equal(dib.readUInt16LE(12), 1);
  assert.equal(dib.readUInt16LE(14), 32);
  assert.equal(dib.readUInt32LE(16), 0); // BI_RGB
  assert.equal(dib.length, 40 + size * size * 4 + size * 4); // 16 px mask rows are padded to 4 bytes
  const stored = 40; // bottom-up: the image's bottom row is stored first
  assert.deepEqual([...dib.subarray(stored + (size - 1) * 4, stored + size * 4)], [60, 50, 40, 0]); // BGRA
  const topRow = stored + (size - 1) * size * 4;
  assert.deepEqual([...dib.subarray(topRow, topRow + 4)], [30, 20, 10, 255]);
  const mask = stored + size * size * 4;
  assert.equal(dib[mask + 1], 0x01); // bottom row, last pixel transparent: bit set, MSB first
  assert.equal(dib[mask + (size - 1) * 4], 0x00); // top row, first pixel opaque
});

test('encodeIco stores DIBs below 256 and PNG at 256, with 256 written as 0', () => {
  const ico = encodeIco([16, 256].map((size) => ({ size, data: size < 256 ? encodeDib(renderMark({ size, samples: 1 }), size) : encodePng(renderMark({ size, samples: 1 }), size) })));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 2);
  assert.equal(ico[6], 16);
  assert.equal(ico[6 + 16], 0);
  const first = ico.readUInt32LE(6 + 12);
  assert.equal(ico.readUInt32LE(first), 40); // BITMAPINFOHEADER, not a PNG signature
  const second = ico.readUInt32LE(6 + 16 + 12);
  assert.deepEqual([...ico.subarray(second, second + 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('every shipped app icon entry is a DIB except the 256 PNG', () => {
  const ico = buildIcons()['assets/icon.ico'];
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const e = 6 + 16 * i;
    const off = ico.readUInt32LE(e + 12);
    const isPng = ico.readUInt32BE(off) === 0x89504e47;
    assert.equal(isPng, ico[e] === 0, `entry ${i}`);
  }
});

test('buildIcons produces exactly the six shipped files', () => {
  const icons = buildIcons();
  assert.deepEqual(Object.keys(icons).sort(), ['assets/icon.ico', 'assets/tray-degraded.ico', 'assets/tray-down.ico', 'assets/tray-up.ico', 'build/icon.ico', 'build/icon.png']);
  assert.equal(icons['build/icon.ico'].readUInt16LE(4), APP_ICON_SIZES.length);
  assert.equal(icons['assets/tray-up.ico'].readUInt16LE(4), TRAY_ICON_SIZES.length);
});

test('the committed icons exist and have the expected sizes', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const ico = fs.readFileSync(path.join(root, 'build', 'icon.ico'));
  assert.equal(ico.readUInt16LE(4), APP_ICON_SIZES.length);
  const png = fs.readFileSync(path.join(root, 'build', 'icon.png'));
  assert.equal(png.readUInt32BE(16), 256);
  for (const s of ['up', 'degraded', 'down']) assert.ok(fs.statSync(path.join(root, 'assets', `tray-${s}.ico`)).size > 100);
});
