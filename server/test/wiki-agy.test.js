import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { extractAgyText, agyGenerate, agyChildEnv, pickAgyDb, DEFAULT_AGY_MODEL } from '../lib/observability/wiki-agy.js';

// Minimal protobuf encoders for building test payloads.
function varint(n) {
  const b = [];
  while (n > 0x7f) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  b.push(n & 0x7f);
  return Buffer.from(b);
}
function field(num, buf) { // wire type 2 (length-delimited)
  const tag = num * 8 + 2;
  return Buffer.concat([varint(tag), varint(buf.length), buf]);
}
function str(s) { return Buffer.from(s, 'utf8'); }

test('extractAgyText pulls the answer from protobuf field path (20,1)', () => {
  // field 20 = submessage { field1 = "answer text", field3 = "chain of thought" }
  const sub = Buffer.concat([field(1, str('the answer text')), field(3, str('chain of thought decoy'))]);
  const payload = field(20, sub);
  assert.equal(extractAgyText(payload), 'the answer text');
});

test('extractAgyText falls back to (20,8) when (20,1) is absent', () => {
  const sub = Buffer.concat([field(3, str('cot')), field(8, str('duplicate answer'))]);
  assert.equal(extractAgyText(field(20, sub)), 'duplicate answer');
});

test('extractAgyText throws when no answer field present', () => {
  assert.throws(() => extractAgyText(field(20, field(3, str('only cot')))), /not found/);
});

function fakeChild(events) {
  return { on(ev, cb) { if (events[ev]) setImmediate(() => cb(events[ev].arg)); return this; } };
}

test('agyGenerate: spawns agy (stdio ignore), reads the DB blob, returns extracted text (mocked)', async () => {
  const sub = Buffer.concat([field(1, str('generated wiki prose'))]);
  const blob = field(20, sub);
  let ranArgs = null;
  const spawnImpl = (bin, args, opts) => { ranArgs = { bin, args, opts }; return fakeChild({ close: { arg: 0 } }); };
  const result = await agyGenerate('Write the Server page.', { spawnImpl, readDb: () => blob });
  assert.equal(result, 'generated wiki prose');
  assert.equal(ranArgs.bin, 'agy');
  assert.equal(ranArgs.args[0], '--model');   // --model MUST precede -p
  const pIdx = ranArgs.args.indexOf('-p');
  assert.ok(pIdx > ranArgs.args.indexOf('--model') && pIdx >= 0);
  assert.deepEqual(ranArgs.opts.stdio, ['ignore', 'pipe', 'pipe']); // stdin closed (avoids the stdin-pipe hang); stdout/stderr read for errors
  for (const a of ['--continue', '--conversation']) assert.equal(ranArgs.args.includes(a), false, a);
  // tool guard is prepended so agy can't touch the repo
  assert.ok(ranArgs.args[ranArgs.args.length - 1].includes('Do NOT use any tools'));
});

test('agyGenerate: fatal when agy binary missing (ENOENT)', async () => {
  const spawnImpl = () => fakeChild({ error: { arg: Object.assign(new Error('nope'), { code: 'ENOENT' }) } });
  await assert.rejects(() => agyGenerate('x', { spawnImpl, readDb: () => Buffer.alloc(0) }), /nope|ENOENT/);
});

test('F8: agy runs with an allowlisted environment: no tokens or API keys reach it', async () => {
  let opts = null;
  const spawnImpl = (bin, args, o) => { opts = o; return fakeChild({ close: { arg: 0 } }); };
  const blob = field(20, field(1, str('x')));
  const env = agyChildEnv({ PATH: '/bin', USERPROFILE: 'C:/u', GEMINI_API_KEY: 'k', GLMPS_ACCESS_TOKEN: 't', ANTHROPIC_API_KEY: 'a', GH_TOKEN: 'g' });
  await agyGenerate('p', { spawnImpl, readDb: () => blob, env });
  assert.deepEqual(opts.env, { PATH: '/bin', USERPROFILE: 'C:/u' });
});

test('F8: by default agyGenerate builds that environment from process.env', async () => {
  const saved = process.env.GLMPS_ACCESS_TOKEN;
  process.env.GLMPS_ACCESS_TOKEN = 'must-not-leak';
  try {
    let opts = null;
    const spawnImpl = (bin, args, o) => { opts = o; return fakeChild({ close: { arg: 0 } }); };
    await agyGenerate('p', { spawnImpl, readDb: () => field(20, field(1, str('x'))) });
    assert.equal(opts.env.GLMPS_ACCESS_TOKEN, undefined);
    assert.ok('PATH' in opts.env || 'Path' in opts.env, 'PATH survives');
  } finally { if (saved === undefined) delete process.env.GLMPS_ACCESS_TOKEN; else process.env.GLMPS_ACCESS_TOKEN = saved; }
});

test('F8: the agy --help capability probe gets the allowlisted env too, so no spawn leaks a secret', async () => {
  const spawns = [];
  const base = fakeAgy({ helpText: HELP_OLD }).spawnImpl;
  const spawnImpl = (bin, args, opts) => { spawns.push({ args, opts }); return base(bin, args, opts); };
  const env = agyChildEnv({ PATH: '/bin', GEMINI_API_KEY: 'k', GLMPS_ACCESS_TOKEN: 't', GH_TOKEN: 'g' });
  await agyGenerate('p', { spawnImpl, readDb: () => okBlob, cwd: '.', env });
  assert.ok(spawns.some((s) => s.args[0] === '--help'), 'the probe ran');
  for (const s of spawns) {
    assert.deepEqual(s.opts.env, { PATH: '/bin' }, `spawn ${s.args[0]} carries only the allowlist`);
  }
});

// agy 1.3.4 (diagnosed live, 2026-10): "Gemini 3.5 Flash (High)" no longer
// exists and agy exits 1 with the reason on stderr. --output-format json names
// the conversation, so the DB is opened by id, not guessed by mtime.
const okBlob = Buffer.from([0xa2, 0x01, 0x04, 0x0a, 0x02, 0x6f, 0x6b]); // field 20 { field 1: "ok" }

// A fake agy: `agy --help` prints helpText; the real call prints out/err and exits with code.
function fakeAgy({ helpText = '', out = '', err = '', code = 0, onRun = null } = {}) {
  const runs = [];
  const spawnImpl = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const help = args[0] === '--help';
    if (!help) runs.push({ bin, args, opts });
    setImmediate(() => {
      if (!help) onRun?.();
      if (help) child.stdout.emit('data', Buffer.from(helpText));
      else { if (out) child.stdout.emit('data', Buffer.from(out)); if (err) child.stderr.emit('data', Buffer.from(err)); }
      child.emit('close', help ? 0 : code);
    });
    return child;
  };
  return { spawnImpl, runs };
}
const HELP_JSON = ['Usage: agy [options]', '  --model <name>', '  --output-format <text|json>', '  -p, --print <prompt>', ''].join('\n');
const HELP_OLD = ['Usage: agy [options]', '  --model <name>', '  -p <prompt>', ''].join('\n');

test('the default agy model is the newest allowlisted Gemini (card glmps-2-0-164)', () => {
  assert.equal(DEFAULT_AGY_MODEL, 'Gemini 4 Argon (High)');
});

test('agyGenerate: a non-zero exit rejects with the stderr tail, never the generic no-DB message', async () => {
  const { spawnImpl } = fakeAgy({ helpText: HELP_OLD, err: 'Error: invalid model selection "Gemini 3.5 Flash (High)"\n', code: 1 });
  await assert.rejects(
    agyGenerate('x', { spawnImpl, readDb: () => okBlob, cwd: '.', model: 'Gemini 3.5 Flash (High)' }),
    (e) => /exited with code 1/.test(e.message) && /invalid model selection/.test(e.message) && !/no new conversation DB/.test(e.message),
  );
});

test('agyGenerate: with --output-format json, SUCCESS reads exactly the named conversation DB', async () => {
  const { spawnImpl, runs } = fakeAgy({ helpText: HELP_JSON, out: JSON.stringify({ status: 'SUCCESS', conversation_id: 'conv-123', response: 'ignored' }) + '\n' });
  const asked = [];
  const out = await agyGenerate('x', { spawnImpl, cwd: '.', convDir: '/agy/conversations', readDb: (dir, ctx) => { asked.push({ dir, ctx }); return okBlob; } });
  assert.equal(out, 'ok');
  const args = runs[0].args;
  assert.equal(args[0], '--model');
  assert.ok(args.indexOf('--output-format') !== -1 && args[args.indexOf('--output-format') + 1] === 'json');
  assert.ok(args.indexOf('--model') < args.indexOf('-p') && args.indexOf('--output-format') < args.indexOf('-p'), 'flags before -p');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].ctx.conversationId, 'conv-123');
});

test('agyGenerate: with --output-format json, ERROR rejects with its error', async () => {
  const { spawnImpl } = fakeAgy({ helpText: HELP_JSON, out: JSON.stringify({ status: 'ERROR', error: 'quota exhausted for this account' }), code: 1 });
  let read = false;
  await assert.rejects(agyGenerate('x', { spawnImpl, cwd: '.', readDb: () => { read = true; return okBlob; } }), /quota exhausted for this account/);
  assert.equal(read, false, 'no DB is read for an ERROR');
});

test('agyGenerate: without --output-format (1.0.10), the DB is the one the call created (set difference)', async () => {
  const conv = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-agy-conv-'));
  fs.writeFileSync(path.join(conv, 'old.db'), '');
  const { spawnImpl, runs } = fakeAgy({ helpText: HELP_OLD, onRun: () => {
    fs.writeFileSync(path.join(conv, 'new.db'), '');
    // the old DB is touched after the new one (another agy client): newest-mtime would pick it
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(conv, 'old.db'), later, later);
  } });
  const asked = [];
  const out = await agyGenerate('x', { spawnImpl, cwd: '.', convDir: conv, readDb: (dir, ctx) => { asked.push(ctx); return okBlob; } });
  assert.equal(out, 'ok');
  assert.equal(runs[0].args.includes('--output-format'), false);
  assert.equal(asked[0].conversationId ?? null, null);
  assert.equal(pickAgyDb(conv, asked[0]), path.join(conv, 'new.db'));
});

test('pickAgyDb: a named conversation wins; else the set difference; else the newest mtime', () => {
  const conv = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-agy-pick-'));
  for (const n of ['a.db', 'b.db', 'c.db']) fs.writeFileSync(path.join(conv, n), '');
  const t = Date.now();
  fs.utimesSync(path.join(conv, 'c.db'), new Date(t + 5000), new Date(t + 5000));
  assert.equal(pickAgyDb(conv, { conversationId: 'a', before: new Set(), sinceMs: t }), path.join(conv, 'a.db'));
  assert.equal(pickAgyDb(conv, { before: new Set(['a.db', 'c.db']), sinceMs: t }), path.join(conv, 'b.db'));
  assert.equal(pickAgyDb(conv, { before: new Set(['a.db', 'b.db', 'c.db']), sinceMs: t }), path.join(conv, 'c.db'));
  assert.equal(pickAgyDb(path.join(conv, 'missing'), { before: new Set(), sinceMs: t }), null);
});

test('review P4: pickAgyDb refuses a conversation id that is not a plain id', () => {
  const conv = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-agy-badid-'));
  try {
    for (const bad of ['..', '../x', 'a/b', 'a\\b', '..\\..\\evil', 'a..b', 'x.db/..', '', ' ', 'a b', 'C:\\x']) {
      if (bad === '') continue; // empty means "no conversation named", handled by the fallbacks
      assert.throws(() => pickAgyDb(conv, { conversationId: bad }), /invalid conversation id/, JSON.stringify(bad));
    }
    assert.equal(pickAgyDb(conv, { conversationId: 'abc-123_DEF' }), path.join(conv, 'abc-123_DEF.db'));
  } finally { fs.rmSync(conv, { recursive: true, force: true }); }
});

test('review P4: the throwaway cwd agyGenerate creates is removed afterwards', async () => {
  const blob = field(20, field(1, str('prose')));
  let cwdSeen = null;
  const spawnImpl = (bin, args, opts) => { if (opts?.cwd) cwdSeen = opts.cwd; return fakeChild({ close: { arg: 0 } }); };
  await agyGenerate('x', { spawnImpl, readDb: () => blob });
  assert.ok(cwdSeen, 'agy was spawned in a throwaway cwd');
  assert.equal(fs.existsSync(cwdSeen), false, 'and it is gone once the call returns');
});

test('review P4: the throwaway cwd is removed when the call fails too', async () => {
  let cwdSeen = null;
  const spawnImpl = (bin, args, opts) => { if (opts?.cwd) cwdSeen = opts.cwd; return fakeChild({ close: { arg: 3 } }); };
  await assert.rejects(agyGenerate('x', { spawnImpl, readDb: () => null }));
  assert.equal(fs.existsSync(cwdSeen), false);
});

test('review P4: a caller-supplied cwd is never removed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-agy-keep-'));
  try {
    const spawnImpl = () => fakeChild({ close: { arg: 0 } });
    await agyGenerate('x', { spawnImpl, cwd: dir, readDb: () => field(20, field(1, str('p'))) });
    assert.equal(fs.existsSync(dir), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agyGenerate fails fast when agy falls into interactive sign-in', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-signin-'));
  let killed = 0;
  const spawnImpl = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    if (args[0] === '--help') { setImmediate(() => { child.stdout.emit('data', '--output-format --log-file'); child.emit('close', 0); }); return child; }
    const log = args[args.indexOf('--log-file') + 1];
    setTimeout(() => fs.writeFileSync(log, 'I1015 printmode.go:426] Print mode: triggering interactive OAuth\n'), 50);
    child.kill = () => child.emit('close', null, 'SIGTERM');
    return child;
  };
  const t0 = Date.now();
  await assert.rejects(
    agyGenerate('hi', { spawnImpl, cwd: dir, convDir: dir, timeout: 30000, readDb: () => null, killTree: (c) => { killed += 1; c.kill(); }, logWatchMs: 20 }),
    (e) => e.code === 'AGY_NOT_SIGNED_IN' && /not signed in/.test(e.message),
  );
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(killed, 1);
});

test('agyGenerate: a help text without --log-file adds no --log-file flag', async () => {
  const { spawnImpl, runs } = fakeAgy({ helpText: HELP_JSON });
  await agyGenerate('x', { spawnImpl, cwd: '.', readDb: () => okBlob });
  assert.equal(runs[0].args.includes('--log-file'), false);
});
