// Tests for the committed SCUT avatar set and its generator
// (scripts/scut-avatars.mjs). Nothing here touches Slack: it proves the files an
// operator is asked to publish actually exist, are readable PNGs, and still
// match the generator that produced them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AGENT_IDS, SCUT_AVATAR_SLUG } from '../lib/scut/bobiverse.js';
import {
  renderAvatar, renderAppIcon, encodePng, decodePng, writeAll,
  AVATAR_SLUGS, AVATAR_SIZE, APP_ICON_SIZE,
} from '../../scripts/scut-avatars.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ASSETS = join(REPO, 'assets', 'scut');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('the roster and the avatar set cover the same agents, plus SCUT itself', () => {
  assert.deepEqual(AVATAR_SLUGS, [...AGENT_IDS, SCUT_AVATAR_SLUG]);
});

test('every agent has a committed avatar in BOTH modes, plus the app icon', () => {
  for (const mode of ['pro', 'bob']) {
    for (const id of AVATAR_SLUGS) {
      const buf = readFileSync(join(ASSETS, mode, `${id}.png`));
      assert.ok(buf.subarray(0, 8).equals(PNG_SIGNATURE), `${mode}/${id}.png is not a PNG`);
      const { width, height } = decodePng(buf);
      assert.equal(width, AVATAR_SIZE, `${mode}/${id}.png width`);
      assert.equal(height, AVATAR_SIZE, `${mode}/${id}.png height`);
    }
  }
  const icon = decodePng(readFileSync(join(ASSETS, 'app-icon.png')));
  assert.equal(icon.width, APP_ICON_SIZE);
  assert.equal(icon.height, APP_ICON_SIZE);
});

test('the committed artwork still matches the generator', () => {
  // Compared as PIXELS, not as file bytes: deflate output is not guaranteed
  // identical across zlib versions and CI runs more than one Node. Pixels are
  // what actually drifts when someone edits the generator.
  for (const mode of ['pro', 'bob']) {
    for (const id of AVATAR_SLUGS) {
      const committed = decodePng(readFileSync(join(ASSETS, mode, `${id}.png`)));
      const fresh = renderAvatar({ id, mode });
      assert.ok(committed.rgba.equals(fresh.rgba),
        `${mode}/${id}.png drifted from the generator - run: node scripts/scut-avatars.mjs`);
    }
  }
  const icon = decodePng(readFileSync(join(ASSETS, 'app-icon.png')));
  assert.ok(icon.rgba.equals(renderAppIcon().rgba),
    'app-icon.png drifted from the generator - run: node scripts/scut-avatars.mjs');
});

test('rendering is deterministic - the starfield is seeded, not random', () => {
  // Without this the "matches the generator" test above would be a coin flip.
  const a = renderAvatar({ id: 'mario', mode: 'bob', size: 64 });
  const b = renderAvatar({ id: 'mario', mode: 'bob', size: 64 });
  assert.ok(a.rgba.equals(b.rgba));
  const other = renderAvatar({ id: 'homer', mode: 'bob', size: 64 });
  assert.ok(!a.rgba.equals(other.rgba), 'two agents must not render identically');
});

test('the two modes produce visibly different pictures for the same agent', () => {
  const pro = renderAvatar({ id: 'riker', mode: 'pro', size: 64 });
  const bob = renderAvatar({ id: 'riker', mode: 'bob', size: 64 });
  let differing = 0;
  for (let i = 0; i < pro.rgba.length; i += 4) {
    if (Math.abs(pro.rgba[i] - bob.rgba[i]) > 8 || Math.abs(pro.rgba[i + 2] - bob.rgba[i + 2]) > 8) differing += 1;
  }
  // A theme change the operator cannot see is not a theme change.
  assert.ok(differing > 64 * 64 * 0.25, `only ${differing} px differ between modes`);
});

test('every avatar is fully opaque - Slack composites the icon on its own background', () => {
  const { rgba } = renderAvatar({ id: 'guppy', mode: 'pro', size: 32 });
  for (let i = 3; i < rgba.length; i += 4) assert.equal(rgba[i], 255);
});

test('encodePng round-trips through decodePng', () => {
  const { width, height, rgba } = renderAvatar({ id: 'bill', mode: 'bob', size: 32 });
  const decoded = decodePng(encodePng(rgba, width, height));
  assert.equal(decoded.width, 32);
  assert.equal(decoded.height, 32);
  assert.ok(decoded.rgba.equals(rgba));
});

test('renderAvatar refuses an unknown agent or mode instead of drawing a blank', () => {
  assert.throws(() => renderAvatar({ id: 'nobody', mode: 'pro' }), /aperture/);
  assert.throws(() => renderAvatar({ id: 'riker', mode: 'sideways' }), /mode/);
});

test('writeAll lays the set out as <mode>/<id>.png, which is what avatarUrl expects', () => {
  const out = mkdtempSync(join(tmpdir(), 'scut-avatars-'));
  try {
    const written = writeAll(out);
    assert.equal(written.length, AVATAR_SLUGS.length * 2 + 1);
    assert.ok(written.includes('pro/riker.png'));
    assert.ok(written.includes('bob/medeiros.png'));
    assert.ok(written.includes('app-icon.png'));
    for (const rel of written) {
      assert.ok(readFileSync(join(out, rel)).subarray(0, 8).equals(PNG_SIGNATURE), rel);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
