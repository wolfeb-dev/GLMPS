import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fetchEmbedModel, parseArgs, defaultOutDir } from '../../scripts/fetch-embed-model.mjs';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writePluginJson(dir, files) {
  const p = path.join(dir, 'plugin.json');
  fs.writeFileSync(p, JSON.stringify({ model: { repo: 'acme/fake-model', files } }));
  return p;
}

test('parseArgs: no --out falls back to defaultOutDir, honouring GLMPS_STATE_DIR', () => {
  const env = { GLMPS_STATE_DIR: path.join(os.tmpdir(), 'mc-fetch-embed-statedir-test') };
  const { outDir } = parseArgs([], env);
  assert.equal(outDir, defaultOutDir(env));
  assert.equal(outDir, path.join(env.GLMPS_STATE_DIR, 'models', 'bge-small-en-v1.5'));
});

test('parseArgs: --out <dir> resolves the given directory', () => {
  const { outDir } = parseArgs(['--out', '/tmp/some-model-dir']);
  assert.equal(outDir, path.resolve('/tmp/some-model-dir'));
});

test('parseArgs: --out with nothing after it (end of argv) is a usage error', () => {
  assert.throws(() => parseArgs(['--out']), /usage: node scripts\/fetch-embed-model\.mjs/);
});

test('parseArgs: --out immediately followed by another flag is a usage error, not a silent fall-through', () => {
  assert.throws(() => parseArgs(['--out', '--verbose']), /usage: node scripts\/fetch-embed-model\.mjs/);
});

test('fetchEmbedModel: a SHA-256 mismatch throws and writes nothing', async () => {
  const dir = tmpDir('mc-fetch-embed-mismatch-');
  const outDir = path.join(dir, 'out');
  const content = Buffer.from('real file bytes');
  const wrongHash = sha256(Buffer.from('different bytes entirely'));
  const pluginJsonPath = writePluginJson(dir, { 'a.txt': wrongHash });
  const fetchImpl = async () => ({ ok: true, statusText: 'OK', arrayBuffer: async () => content });

  await assert.rejects(
    fetchEmbedModel({ outDir, pluginJsonPath, fetchImpl }),
    /a\.txt: SHA-256 mismatch/,
  );
  assert.equal(fs.existsSync(path.join(outDir, 'a.txt')), false);
});

test('fetchEmbedModel: matching hashes write both files, only under the given outDir', async () => {
  const dir = tmpDir('mc-fetch-embed-match-');
  const outDir = path.join(dir, 'out');
  const bodies = {
    'a.txt': Buffer.from('file a contents'),
    'nested/b.bin': Buffer.from([1, 2, 3, 4, 5]),
  };
  const files = Object.fromEntries(Object.entries(bodies).map(([rel, buf]) => [rel, sha256(buf)]));
  const pluginJsonPath = writePluginJson(dir, files);
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    const rel = url.replace('https://huggingface.co/acme/fake-model/resolve/main/', '');
    return { ok: true, statusText: 'OK', arrayBuffer: async () => bodies[rel] };
  };

  const written = await fetchEmbedModel({ outDir, pluginJsonPath, fetchImpl });

  assert.equal(Object.keys(written).length, 2);
  for (const [rel, buf] of Object.entries(bodies)) {
    const dest = path.join(outDir, rel);
    assert.equal(written[rel], dest);
    assert.ok(fs.existsSync(dest));
    assert.deepEqual(fs.readFileSync(dest), buf);
    // Written only under outDir: the resolved path must not escape it.
    assert.ok(dest === outDir || dest.startsWith(outDir + path.sep));
  }
  assert.equal(requestedUrls.length, 2);
  // Nothing was written anywhere outside outDir (e.g. no accidental write to
  // the real default state dir), since fetchEmbedModel never touches
  // anything but the outDir it is given.
  assert.deepEqual(fs.readdirSync(dir).sort(), ['out', 'plugin.json']);
});

// a file with no pinned hash used to
// download and write anyway (a warning, not a failure) - the same
// supply-chain risk a mismatched hash already refuses, just silent when the
// pin is simply missing rather than wrong. Fails closed by default now;
// --allow-unpinned (an explicit, auditable opt-in for the genuine first-run
// bootstrap case) restores the old behavior.
test('fetchEmbedModel: a file with no hash recorded yet fails closed by default, writing nothing', async () => {
  const dir = tmpDir('mc-fetch-embed-nohash-');
  const outDir = path.join(dir, 'out');
  const content = Buffer.from('first download, no pin yet');
  const pluginJsonPath = writePluginJson(dir, { 'a.txt': '' });
  const fetchImpl = async () => ({ ok: true, statusText: 'OK', arrayBuffer: async () => content });

  await assert.rejects(
    fetchEmbedModel({ outDir, pluginJsonPath, fetchImpl }),
    /a\.txt: no SHA-256 pinned/,
  );
  assert.equal(fs.existsSync(path.join(outDir, 'a.txt')), false);
});

test('fetchEmbedModel: allowUnpinned:true restores the old first-run bootstrap behavior', async () => {
  const dir = tmpDir('mc-fetch-embed-nohash-allow-');
  const outDir = path.join(dir, 'out');
  const content = Buffer.from('first download, no pin yet');
  const pluginJsonPath = writePluginJson(dir, { 'a.txt': '' });
  const fetchImpl = async () => ({ ok: true, statusText: 'OK', arrayBuffer: async () => content });

  const written = await fetchEmbedModel({ outDir, pluginJsonPath, fetchImpl, allowUnpinned: true });
  assert.deepEqual(fs.readFileSync(written['a.txt']), content);
});

test('parseArgs: --allow-unpinned is parsed as a flag', () => {
  assert.equal(parseArgs([]).allowUnpinned, false);
  assert.equal(parseArgs(['--allow-unpinned']).allowUnpinned, true);
  assert.equal(parseArgs(['--out', '/tmp/x', '--allow-unpinned']).allowUnpinned, true);
});
