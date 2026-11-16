// Tests for the published-avatar checker (server/lib/scut/avatar-check.js).
// fetch is injected, so nothing here touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedAvatarPaths, checkAvatarBase, diagnose, formatReport } from '../lib/scut/avatar-check.js';
import { AGENT_IDS } from '../lib/scut/bobiverse.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const HTML = Buffer.from('<!doctype html><title>Sign in to GitHub</title>');

/** A fake host. `serve(path)` returns {status, body} for a relative avatar path. */
function fakeFetch(serve) {
  const seen = [];
  const impl = async (url) => {
    seen.push(String(url));
    const { status = 200, body = PNG } = serve(String(url)) ?? {};
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
  return { impl, seen };
}

test('expectedAvatarPaths is the whole published set: both modes plus the app icon', () => {
  const paths = expectedAvatarPaths();
  assert.equal(paths.length, (AGENT_IDS.length + 1) * 2 + 1); // +1 slug for scut, +1 file for the icon
  assert.ok(paths.includes('pro/riker.png'));
  assert.ok(paths.includes('bob/medeiros.png'));
  assert.ok(paths.includes('app-icon.png'));
});

test('a fully published host reports ok, having requested every expected file', async () => {
  const { impl, seen } = fakeFetch(() => ({ status: 200, body: PNG }));
  const report = await checkAvatarBase('https://cdn.example/scut/', { fetchImpl: impl });
  assert.equal(report.ok, true);
  assert.equal(report.base, 'https://cdn.example/scut');
  assert.equal(report.results.length, expectedAvatarPaths().length);
  assert.equal(seen.length, expectedAvatarPaths().length);
  assert.ok(seen.includes('https://cdn.example/scut/bob/guppy.png'));
  assert.ok(report.results.every((r) => r.ok && r.isPng));
});

test('a missing file is reported per path, not as a blanket failure', async () => {
  const { impl } = fakeFetch((url) => (url.endsWith('bob/homer.png') ? { status: 404 } : {}));
  const report = await checkAvatarBase('https://cdn.example/scut', { fetchImpl: impl });
  assert.equal(report.ok, false);
  const bad = report.results.filter((r) => !r.ok);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].path, 'bob/homer.png');
  assert.equal(bad[0].status, 404);
});

test('a 200 that is not a PNG fails - an HTML sign-in page is the classic private-repo answer', async () => {
  // A status-only probe would call this a pass and send Slack a URL that renders
  // nothing. This is the single most valuable assertion in the file.
  const { impl } = fakeFetch(() => ({ status: 200, body: HTML }));
  const report = await checkAvatarBase('https://cdn.example/scut', { fetchImpl: impl });
  assert.equal(report.ok, false);
  assert.ok(report.results.every((r) => r.status === 200 && !r.isPng && !r.ok));
});

test('a transport failure is captured per path instead of throwing', async () => {
  const impl = async () => { throw new Error('getaddrinfo ENOTFOUND cdn.example'); };
  const report = await checkAvatarBase('https://cdn.example/scut', { fetchImpl: impl });
  assert.equal(report.ok, false);
  assert.match(report.results[0].error, /ENOTFOUND/);
});

test('an unusable base is refused before a single request is made', async () => {
  const { impl, seen } = fakeFetch(() => ({}));
  for (const bad of ['http://127.0.0.1:8123/assets', 'file:///tmp/x', '', null]) {
    const report = await checkAvatarBase(bad, { fetchImpl: impl });
    assert.equal(report.ok, false);
    assert.equal(report.base, null);
    assert.deepEqual(report.results, []);
  }
  assert.deepEqual(seen, [], 'no request is worth making against a URL Slack would reject');
});

test('a clean check tells the operator the exact line to set, and exits 0', async () => {
  const { impl } = fakeFetch(() => ({ status: 200, body: PNG }));
  const report = await checkAvatarBase('https://cdn.example/scut', { fetchImpl: impl });
  const out = formatReport(report, { requested: 'https://cdn.example/scut', configured: null, settingsFile: 'S.json' });
  assert.equal(out.exitCode, 0);
  const text = out.lines.join('\n');
  assert.match(text, /All 17 files are published/);
  assert.match(text, /SCUT_AVATAR_BASE_URL=https:\/\/cdn\.example\/scut/);
  assert.match(text, /S\.json/);
});

test('a clean check of the ALREADY-configured base does not tell you to set it again', async () => {
  const { impl } = fakeFetch(() => ({ status: 200, body: PNG }));
  const report = await checkAvatarBase('https://cdn.example/scut', { fetchImpl: impl });
  const text = formatReport(report, { requested: null, configured: 'https://cdn.example/scut' }).lines.join('\n');
  assert.doesNotMatch(text, /SCUT_AVATAR_BASE_URL=/);
  assert.match(text, /pointed here already/);
});

test('a failing check exits 1 and states a 404 plainly, without calling it "not an image"', async () => {
  const { impl } = fakeFetch(() => ({ status: 404, body: Buffer.from('404: Not Found') }));
  const report = await checkAvatarBase('https://cdn.example/scut', { fetchImpl: impl });
  const out = formatReport(report, {});
  assert.equal(out.exitCode, 1);
  const text = out.lines.join('\n');
  assert.match(text, /pro\/riker\.png\s+HTTP 404$/m);
  assert.doesNotMatch(text, /HTTP 404.*not an image/);
  assert.match(text, /\.\.\. and 12 more/); // only the first 5 are listed
  assert.match(text, /docs\/scut-profile-pictures\.md/);
});

test('diagnose names the causes an operator can act on', async () => {
  const notFound = { base: 'https://raw.githubusercontent.com/me/repo/main/assets/scut', ok: false,
    results: [{ path: 'pro/riker.png', status: 404, ok: false, isPng: false }] };
  const lines = diagnose(notFound).join('\n');
  assert.match(lines, /public/i);       // a private repo 404s for Slack
  assert.match(lines, /branch/i);       // main vs master
  assert.match(lines, /pro\/ and bob\//); // pointed at the repo root, not the folder

  const notImage = { base: 'https://github.com/me/repo/blob/main/assets/scut', ok: false,
    results: [{ path: 'pro/riker.png', status: 200, ok: false, isPng: false }] };
  assert.match(diagnose(notImage).join('\n'), /raw\.githubusercontent\.com/);

  const refused = { base: null, ok: false, results: [] };
  assert.match(diagnose(refused).join('\n'), /https/);

  assert.deepEqual(diagnose({ base: 'https://cdn.example/scut', ok: true, results: [] }), []);
});
