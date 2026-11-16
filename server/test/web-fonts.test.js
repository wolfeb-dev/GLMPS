// card glmps-2-0-runtime-77 AC-1: no stylesheet holds first paint on a remote
// font import. The house faces are served from this origin and declared once,
// in the token file both the app and the sandboxed wiki iframe load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.js';
import { claudeTmp } from './fixtures/claude-dir.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const SKIP = new Set(['vendor', 'wiki-assets', 'huddle-assets', 'node_modules']);

function stylesheets(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.has(e.name)) stylesheets(path.join(dir, e.name), out); }
    else if (e.name.endsWith('.css')) out.push(path.join(dir, e.name));
  }
  return out;
}

test('no stylesheet or page imports a font from another origin', () => {
  const hits = [];
  for (const f of [...stylesheets(WEB), path.join(WEB, 'index.html')]) {
    const text = fs.readFileSync(f, 'utf8');
    if (/fonts\.(googleapis|gstatic)\.com/.test(text) || /@import\s+url\(\s*['"]?https?:/i.test(text)) hits.push(path.relative(WEB, f));
  }
  assert.deepEqual(hits, []);
});

test('the token file declares both house faces from local files that exist', () => {
  const css = fs.readFileSync(path.join(WEB, 'shared', 'tokens.css'), 'utf8');
  for (const [family, file] of [['Outfit', 'outfit-latin.woff2'], ['Fira Code', 'fira-code-latin.woff2']]) {
    const face = css.match(new RegExp(`@font-face\\s*\\{[^}]*font-family:\\s*'${family}'[^}]*\\}`));
    assert.ok(face, `${family} @font-face`);
    assert.match(face[0], /font-display:\s*swap/);
    assert.match(face[0], new RegExp(`url\\('\\.\\./fonts/${file}'\\)`));
    assert.equal(fs.readFileSync(path.join(WEB, 'fonts', file)).subarray(0, 4).toString('latin1'), 'wOF2');
  }
});

test('a font is served as font/woff2 and readable from the sandboxed wiki origin', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-fonts-'));
  const claudeDir = claudeTmp();
  const h = await startServer({ port: 0, env: { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off' }, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/fonts/outfit-latin.woff2`, { headers: { origin: 'null' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'font/woff2');
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    const css = await fetch(`http://127.0.0.1:${h.port}/styles.css`);
    assert.equal(css.headers.get('access-control-allow-origin'), null, 'only fonts carry the CORS header');
  } finally {
    await h.close();
    for (const d of [stateDir, claudeDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }
});
