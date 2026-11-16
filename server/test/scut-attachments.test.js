// server/test/scut-attachments.test.js
// SCUT attachment pass-through (server/lib/scut/attachments.js): where a Slack
// file lands on disk, what it is safely named, and what the session is told
// about it. No network - `fetch` is injected - and no real state dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  attachmentsDir, attachmentDirFor, safeName, describeFiles, formatAttachmentBlock,
  downloadFiles, collectAttachments, pruneAttachments,
} from '../lib/scut/attachments.js';

test('attachmentsDir honors GLMPS_STATE_DIR and sits beside the runner prompt files', () => {
  const d = attachmentsDir({ GLMPS_STATE_DIR: path.join(os.tmpdir(), 'st') });
  assert.equal(d, path.join(os.tmpdir(), 'st', 'runner', 'attachments'));
});

test('attachmentDirFor keys by channel and message ts', () => {
  const state = path.join(os.tmpdir(), 'st');
  const d = attachmentDirFor({ channel: 'C123', ts: '1788014503.449529' }, { GLMPS_STATE_DIR: state });
  assert.equal(d, path.join(state, 'runner', 'attachments', 'C123', '1788014503.449529'));
});

test('attachmentDirFor scrubs traversal out of a hostile channel or ts', () => {
  const state = path.join(os.tmpdir(), 'st');
  const d = attachmentDirFor({ channel: '../../etc', ts: '../x' }, { GLMPS_STATE_DIR: state });
  assert.ok(!d.includes('..'), d);
  assert.ok(d.startsWith(path.join(state, 'runner', 'attachments')), d);
});

test('safeName keeps a readable name, prefixes the file id, and defeats traversal', () => {
  assert.equal(safeName({ id: 'F01', name: 'shot.png' }), 'F01-shot.png');
  const evil = safeName({ id: 'F02', name: '../../../.ssh/authorized_keys' });
  assert.ok(!evil.includes('..'), evil);
  assert.ok(!evil.includes('/') && !evil.includes('\\'), evil);
  assert.ok(safeName({ id: 'F03', name: '' }).length > 0);
  assert.ok(safeName({ id: 'F04', name: 'x'.repeat(400) }).length <= 120);
});

test('describeFiles normalizes a Slack event files array and ignores non-arrays', () => {
  const out = describeFiles({ files: [{
    id: 'F1', name: 'a.png', mimetype: 'image/png', size: 12, url_private: 'https://s/a', permalink: 'https://p/a',
  }] });
  assert.deepEqual(out, [{
    id: 'F1', name: 'a.png', mimetype: 'image/png', size: 12, urlPrivate: 'https://s/a', permalink: 'https://p/a',
  }]);
  assert.deepEqual(describeFiles({}), []);
  assert.deepEqual(describeFiles(null), []);
});

test('describeFiles drops a file with no download url rather than inventing one', () => {
  assert.deepEqual(describeFiles({ files: [{ id: 'F1', name: 'a.png' }] }), []);
});

test('formatAttachmentBlock names every local path and states failures out loud', () => {
  const block = formatAttachmentBlock([
    { name: 'a.png', mimetype: 'image/png', size: 2048, ok: true, path: 'C:\\att\\F1-a.png' },
    { name: 'b.pdf', mimetype: 'application/pdf', size: 10, ok: false, error: 'missing files:read scope' },
  ]);
  assert.match(block, /Attachments \(2\)/);
  assert.match(block, /C:\\att\\F1-a\.png/);
  assert.match(block, /b\.pdf/);
  assert.match(block, /NOT DOWNLOADED: missing files:read scope/);
  assert.equal(formatAttachmentBlock([]), '');
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scut-att-'));
const okRes = (body, type) => ({
  ok: true,
  status: 200,
  headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? type : null) },
  arrayBuffer: async () => {
    const bytes = new TextEncoder().encode(body);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  },
});

test('downloadFiles writes the bytes and authenticates with the bot token', async () => {
  const dir = tmp();
  let seen = null;
  const out = await downloadFiles(
    [{ id: 'F1', name: 'a.txt', mimetype: 'text/plain', size: 5, urlPrivate: 'https://files.slack.com/a' }],
    { dir, token: 'xoxb-t', fetchImpl: async (u, o) => { seen = { u, o }; return okRes('hello', 'text/plain'); } },
  );
  assert.equal(out[0].ok, true);
  assert.equal(fs.readFileSync(out[0].path, 'utf8'), 'hello');
  assert.equal(seen.u, 'https://files.slack.com/a');
  assert.equal(seen.o.headers.Authorization, 'Bearer xoxb-t');
});

test('downloadFiles calls an HTML body what it is: the missing files:read scope', async () => {
  const dir = tmp();
  const out = await downloadFiles(
    [{ id: 'F1', name: 'a.png', mimetype: 'image/png', size: 5, urlPrivate: 'https://s/a' }],
    { dir, token: 'xoxb-t', fetchImpl: async () => okRes('<html>sign in</html>', 'text/html; charset=utf-8') },
  );
  assert.equal(out[0].ok, false);
  assert.match(out[0].error, /files:read/);
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0);
});

test('downloadFiles reports an HTTP failure instead of writing a stub file', async () => {
  const dir = tmp();
  const out = await downloadFiles(
    [{ id: 'F1', name: 'a.png', mimetype: 'image/png', size: 5, urlPrivate: 'https://s/a' }],
    { dir, token: 'xoxb-t', fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }) },
  );
  assert.equal(out[0].ok, false);
  assert.match(out[0].error, /404/);
});

test('downloadFiles refuses an oversized file by its declared size, without fetching it', async () => {
  const dir = tmp();
  let called = 0;
  const out = await downloadFiles(
    [{ id: 'F1', name: 'big.bin', mimetype: 'application/octet-stream', size: 99, urlPrivate: 'https://s/a' }],
    { dir, token: 't', maxBytes: 10, fetchImpl: async () => { called += 1; return okRes('x', 'application/octet-stream'); } },
  );
  assert.equal(called, 0);
  assert.equal(out[0].ok, false);
  assert.match(out[0].error, /too large/i);
});

test('downloadFiles caps how many files one message can carry and says so', async () => {
  const dir = tmp();
  const files = Array.from({ length: 3 }, (_, i) => ({
    id: `F${i}`, name: `f${i}.txt`, mimetype: 'text/plain', size: 1, urlPrivate: 'https://s/a',
  }));
  const out = await downloadFiles(files, { dir, token: 't', maxFiles: 2, fetchImpl: async () => okRes('x', 'text/plain') });
  assert.equal(out.length, 3);
  assert.equal(out[2].ok, false);
  assert.match(out[2].error, /only the first 2/i);
});

test('downloadFiles survives a throwing fetch and keeps the other files', async () => {
  const dir = tmp();
  const files = [
    { id: 'F1', name: 'a.txt', mimetype: 'text/plain', size: 1, urlPrivate: 'https://s/a' },
    { id: 'F2', name: 'b.txt', mimetype: 'text/plain', size: 1, urlPrivate: 'https://s/b' },
  ];
  const out = await downloadFiles(files, {
    dir,
    token: 't',
    fetchImpl: async (u) => { if (String(u).endsWith('/a')) throw new Error('boom'); return okRes('ok', 'text/plain'); },
  });
  assert.equal(out[0].ok, false);
  assert.match(out[0].error, /boom/);
  assert.equal(out[1].ok, true);
});

test('collectAttachments returns an empty block for a message with no files', async () => {
  const r = await collectAttachments({ text: 'hi' }, { channel: 'C1', ts: '1.1', token: 't', env: { GLMPS_STATE_DIR: tmp() } });
  assert.equal(r.block, '');
  assert.deepEqual(r.files, []);
});

test('collectAttachments downloads into the per-message dir and returns a block naming the path', async () => {
  const state = tmp();
  const r = await collectAttachments(
    { files: [{ id: 'F1', name: 'a.txt', mimetype: 'text/plain', size: 2, url_private: 'https://s/a' }] },
    { channel: 'C1', ts: '1.1', token: 't', env: { GLMPS_STATE_DIR: state }, fetchImpl: async () => okRes('hi', 'text/plain') },
  );
  assert.equal(r.files[0].ok, true);
  assert.ok(r.files[0].path.startsWith(path.join(state, 'runner', 'attachments', 'C1', '1.1')), r.files[0].path);
  assert.match(r.block, /Attachments \(1\)/);
});

test('collectAttachments reports the whole batch as undelivered when there is no token', async () => {
  const state = tmp();
  const r = await collectAttachments(
    { files: [{ id: 'F1', name: 'a.txt', mimetype: 'text/plain', size: 2, url_private: 'https://s/a' }] },
    { channel: 'C1', ts: '1.1', token: null, env: { GLMPS_STATE_DIR: state }, fetchImpl: async () => okRes('hi', 'text/plain') },
  );
  assert.equal(r.files[0].ok, false);
  assert.match(r.block, /NOT DOWNLOADED/);
});


test('pruneAttachments removes message dirs past the age cap and keeps fresh ones', () => {
  const state = tmp();
  const root = path.join(state, 'runner', 'attachments', 'C1');
  const old = path.join(root, '100.1');
  const fresh = path.join(root, '200.2');
  fs.mkdirSync(old, { recursive: true });
  fs.mkdirSync(fresh, { recursive: true });
  fs.writeFileSync(path.join(old, 'a.txt'), 'x');
  fs.writeFileSync(path.join(fresh, 'b.txt'), 'x');
  const longAgo = Date.now() - 40 * 24 * 3600 * 1000;
  fs.utimesSync(old, longAgo / 1000, longAgo / 1000);

  const removed = pruneAttachments({ GLMPS_STATE_DIR: state }, { maxAgeMs: 14 * 24 * 3600 * 1000 });
  assert.equal(removed, 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
});

test('pruneAttachments is a no-op when nothing has ever been downloaded', () => {
  assert.equal(pruneAttachments({ GLMPS_STATE_DIR: tmp() }), 0);
});

test('collectAttachments prunes on the way past, and only when there are files', async () => {
  const state = tmp();
  const stale = path.join(state, 'runner', 'attachments', 'C9', '1.0');
  fs.mkdirSync(stale, { recursive: true });
  const longAgo = Date.now() - 90 * 24 * 3600 * 1000;
  fs.utimesSync(stale, longAgo / 1000, longAgo / 1000);

  await collectAttachments({ text: 'no files here' }, { channel: 'C1', ts: '2.0', token: 't', env: { GLMPS_STATE_DIR: state } });
  assert.equal(fs.existsSync(stale), true, 'a message with no files must not walk the disk');

  await collectAttachments(
    { files: [{ id: 'F1', name: 'a.txt', mimetype: 'text/plain', size: 2, url_private: 'https://s/a' }] },
    { channel: 'C1', ts: '2.0', token: 't', env: { GLMPS_STATE_DIR: state }, fetchImpl: async () => okRes('hi', 'text/plain') },
  );
  assert.equal(fs.existsSync(stale), false);
});

test('downloadFiles sends the bot token only to slack.com hosts', async () => {
  const cases = [
    ['https://files.slack.com/files-pri/T-F/a.png', true],
    ['https://slack.com/a', true],
    ['https://evil.example.com/a', false],
    ['https://evilslack.com/a', false],
    ['https://slack.com.evil.io/a', false],
    ['http://files.slack.com/a', false],
    ['not a url', false],
  ];
  for (const [urlPrivate, expectAuth] of cases) {
    let init = null;
    await downloadFiles(
      [{ id: 'F1', name: 'a.txt', mimetype: 'text/plain', size: 1, urlPrivate }],
      { dir: tmp(), token: 'xoxb-secret', fetchImpl: async (u, o) => { init = o; return okRes('x', 'text/plain'); } },
    );
    if (init === null) { assert.equal(expectAuth, false, urlPrivate); continue; }
    assert.equal(init.headers?.Authorization, expectAuth ? 'Bearer xoxb-secret' : undefined, urlPrivate);
  }
});

// AbortSignal.timeout is unref'd, so on Node 22 the runner would end the
// file while this fetch hangs; a ref'd timer keeps it open until the abort.
test('downloadFiles aborts a stalled fetch after the timeout and reports it', async () => {
  const out = await downloadFiles(
    [{ id: 'F1', name: 'a.txt', mimetype: 'text/plain', size: 1, urlPrivate: 'https://files.slack.com/a' }],
    {
      dir: tmp(), token: 't', timeoutMs: 30,
      fetchImpl: (u, o) => new Promise((_, reject) => {
        assert.ok(o.signal instanceof AbortSignal, 'fetch is given an AbortSignal');
        const keepalive = setTimeout(() => {}, 10_000);
        o.signal.addEventListener('abort', () => { clearTimeout(keepalive); reject(o.signal.reason); });
      }),
    },
  );
  assert.equal(out[0].ok, false);
  assert.match(out[0].error, /timed out|abort/i);
});
