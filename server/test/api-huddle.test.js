// server/test/api-huddle.test.js
// The huddle HTTP surface against a really booted server, with the Claude
// stream, the Gemini seat, the CLI probe and the Slack relay all replaced by
// fakes: no claude, no agy, no Slack, no real home dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { readSpineEvents, SPINE_KINDS } from '../lib/observability/spine.js';
import { waitFor } from './helpers/wait-for.js';

function tmp(pfx) { return fs.mkdtempSync(path.join(os.tmpdir(), pfx)); }

const fakeStream = async ({ body, onText }) => {
  if (String(body.system).includes('hold the floor')) return { text: '{"speakers":["garfield"],"reason":"risk","ask":""}', stopReason: 'end_turn', ttftMs: 3, totalMs: 6 };
  if (String(body.system).startsWith('Summarise')) return { text: 'Summary line.', stopReason: 'end_turn', ttftMs: 3, totalMs: 6 };
  onText?.('Short answer. ', 'Short answer. ');
  onText?.('Done.', 'Short answer. Done.');
  return { text: 'Short answer. Done.', stopReason: 'end_turn', ttftMs: 20, totalMs: 40 };
};
const fakeSeat = (id = 'homer', respond = async () => ({ text: 'pass', pass: true })) => ({ persona: { id }, model: 'Gemini 3.8 Flash (Medium)', respond });

// huddleSeats: false = no agy seats (they leave the roster), an array = injected
// seats keyed by persona id, 'auto' = the server's own rule (agy seats exist
// when <GLMPS_AGY_CLI_DIR>/conversations exists).
// huddleCfg is written to a config file the server merges over its defaults.
async function boot({ cliAvailable = true, defaultProbe = false, huddleStream = fakeStream, huddleSeats = false, huddlePostSummary = null, agyConversations = false, huddleCfg = null, huddleCardThreads = null, huddleResearcher = false } = {}) {
  const stateDir = tmp('mc-huddle-api-');
  const claudeDir = tmp('mc-claude-');
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  const agyDir = tmp('mc-agy-');
  if (agyConversations) fs.mkdirSync(path.join(agyDir, 'conversations'));
  const assetsDir = tmp('mc-assets-');
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ASSETS_DIR: assetsDir, GLMPS_AGY_CLI_DIR: agyDir, GLMPS_UNMERGED_SCAN: 'off', GLMPS_SCUT: 'off' };
  const configFile = path.join(stateDir, 'huddle-test-config.json');
  if (huddleCfg) fs.writeFileSync(configFile, JSON.stringify({ huddle: huddleCfg }));
  const h = await startServer({
    port: 0, env, configFile, huddleStream,
    huddleCliCheck: defaultProbe ? null : () => cliAvailable,
    huddleSeats: huddleSeats === 'auto' ? undefined : huddleSeats,
    huddlePostSummary,
    huddleCardThreads,
    huddleResearcher: huddleResearcher === 'auto' ? undefined : huddleResearcher,
  });
  const base = `http://127.0.0.1:${h.port}`;
  const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
  return {
    stateDir, base,
    get: (p) => fetch(base + p).then(j),
    post: (p, obj) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj ?? {}) }).then(j),
    closeServer: () => h.close?.(),
    close: async () => {
      try {
        await h.close?.();
        await h.storesClosed;
      } finally {
        for (const d of [stateDir, claudeDir, agyDir, assetsDir]) {
          try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
        }
      }
    },
  };
}

// A minimal SSE reader for /api/events: collects every JSON data frame.
function openSse(base) {
  const ac = new AbortController();
  const seen = [];
  const pump = (async () => {
    try {
      const r = await fetch(`${base}/api/events`, { signal: ac.signal });
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (line) { try { seen.push(JSON.parse(line.slice(6))); } catch { /* not a JSON frame */ } }
        }
      }
    } catch { /* aborted at close */ }
  })();
  return {
    async waitFor(pred, ms = 3000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (seen.some(pred)) return true; await new Promise((r) => setTimeout(r, 20)); }
      return false;
    },
    async close() { ac.abort(); await pump; },
  };
}

test('POST /api/huddle with the claude CLI unavailable answers 503 and changes nothing', async () => {
  const s = await boot({ cliAvailable: false });
  try {
    const r = await s.post('/api/huddle', {});
    assert.equal(r.status, 503);
    assert.match(r.body.error, /claude CLI unavailable/);
  } finally { await s.close(); }
});

test('with no CLI probe injected, a test server answers 503 and never spawns claude (the K test-process guard)', async () => {
  const s = await boot({ defaultProbe: true });
  try {
    assert.equal((await s.post('/api/huddle', {})).status, 503);
  } finally { await s.close(); }
});

test('a disabled huddle answers 404', async () => {
  const s = await boot({ huddleCfg: { enabled: false } });
  try {
    assert.equal((await s.post('/api/huddle', {})).status, 404);
  } finally { await s.close(); }
});

test('a huddle starts with the full roster, answers a named turn, snapshots, and ends with a summary posted through the injected relay', async () => {
  const posted = [];
  const s = await boot({ huddlePostSummary: async (text) => { posted.push(text); } });
  try {
    const start = await s.post('/api/huddle', {});
    assert.equal(start.status, 200);
    assert.equal(start.body.personas.length, 4, 'huddleSeats: false, so the three agy seats leave the roster');
    assert.deepEqual(start.body.personas.map((p) => p.id).sort(), ['bill', 'garfield', 'mario', 'riker']);
    assert.ok(start.body.personas.some((p) => p.id === 'riker'));
    const id = start.body.id;

    const say = await s.post(`/api/huddle/${id}/say`, { text: 'Builder, estimate this' });
    assert.equal(say.status, 200);
    assert.deepEqual(say.body.speakers, ['bill']);
    assert.equal(say.body.via, 'name');

    const snap = await s.get(`/api/huddle/${id}`);
    assert.equal(snap.body.transcript.length, 2);
    assert.equal(snap.body.transcript[1].text, 'Short answer. Done.');
    assert.equal(snap.body.transcript[1].model, 'opus');

    const viaLead = await s.post(`/api/huddle/${id}/say`, { text: 'what breaks first?' });
    assert.deepEqual(viaLead.body.speakers, ['garfield']);
    assert.equal(viaLead.body.via, 'lead');

    const end = await s.post(`/api/huddle/${id}/end`, {});
    assert.equal(end.body.ended, true);
    assert.equal(end.body.summary, 'Summary line.', 'the end response carries the summary (the dock backstop when the SSE ended frame was missed)');
    assert.deepEqual(end.body.summaryPost, { ok: true, error: null });
    assert.deepEqual(posted, ['Summary line.']);
    assert.equal((await s.get(`/api/huddle/${id}`)).status, 404);
    assert.equal(readSpineEvents(s.stateDir, { kind: SPINE_KINDS.HUDDLE_UTTERANCE }).length, 4);
    assert.equal(readSpineEvents(s.stateDir, { kind: SPINE_KINDS.HUDDLE_ENDED })[0].payload.summary, 'Summary line.');
  } finally { await s.close(); }
});

// Pre-warm (operator limit: a reply in under 5 s): the start route starts the
// Lead's and every Claude persona's process in the background, without
// holding the start response, and a failed warm-up never fails the huddle.
test('POST /api/huddle pre-warms the Lead and every Claude persona in the background and answers before they resolve', async () => {
  const warmed = [];
  let releaseWarm;
  const warmGate = new Promise((r) => { releaseWarm = r; });
  const stream = async (args) => fakeStream(args);
  stream.prewarm = (t) => { warmed.push(t); return warmed.length === 1 ? Promise.reject(new Error('warm-up refused')) : warmGate; };
  const s = await boot({ huddleStream: stream, huddleSeats: [fakeSeat('homer')] });
  try {
    const start = await s.post('/api/huddle', {});
    assert.equal(start.status, 200, 'the start answered while every warm-up is still pending');
    const claudePersonas = start.body.personas.filter((p) => !p.seat).length;
    assert.equal(claudePersonas, 4);
    for (let i = 0; i < 100 && warmed.length < claudePersonas + 1; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(warmed.length, claudePersonas + 1, 'one pre-warm per Claude persona plus the Lead');
    assert.equal(warmed.filter((t) => t.system.includes('hold the floor')).length, 1);
    assert.equal(warmed.find((t) => t.system.includes('hold the floor')).model, 'haiku', 'the Lead warms on the floor model');
    assert.deepEqual(warmed.filter((t) => t.system.startsWith('You are Reviewer')).map((t) => t.model), ['sonnet'], 'a mind warms on its own model');
    assert.equal(warmed.some((t) => /You are Researcher/.test(t.system)), false, 'an agy seat is never warmed');
    const say = await s.post(`/api/huddle/${start.body.id}/say`, { text: 'Builder, estimate this' });
    assert.equal(say.status, 200, 'a failed warm-up did not fail the huddle');
    releaseWarm();
    await s.post(`/api/huddle/${start.body.id}/end`, {});
  } finally { releaseWarm(); await s.close(); }
});

test('with Slack off (no relay, scut is null) the ended payload says so; the dock shows it (visible failure)', async () => {
  const s = await boot();
  try {
    const start = await s.post('/api/huddle', {});
    await s.post(`/api/huddle/${start.body.id}/say`, { text: 'Garfield, what breaks?' });
    const end = await s.post(`/api/huddle/${start.body.id}/end`, {});
    assert.deepEqual(end.body.summaryPost, { ok: false, error: 'Slack is not connected' });
  } finally { await s.close(); }
});

test('with an agy seat available the roster gains it, and a subset invite keeps the Lead and the seat', async () => {
  const s = await boot({ huddleSeats: [fakeSeat('homer')] });
  try {
    const all = await s.post('/api/huddle', {});
    assert.ok(all.body.personas.some((p) => p.id === 'homer' && p.seat === 'agy'));
    assert.equal(all.body.personas.length, 5);
    const some = await s.post('/api/huddle', { personas: ['bill'] });
    assert.deepEqual(some.body.personas.map((p) => p.id).sort(), ['bill', 'homer', 'riker']);
    await s.post(`/api/huddle/${all.body.id}/end`, {});
    await s.post(`/api/huddle/${some.body.id}/end`, {});
  } finally { await s.close(); }
});

test('the agy seats join on their own only when <P.agyCliDir>/conversations exists, and say why when they cannot', async () => {
  const without = await boot({ huddleSeats: 'auto' });
  const withIt = await boot({ huddleSeats: 'auto', agyConversations: true });
  const off = await boot({ huddleSeats: 'auto', agyConversations: true, huddleCfg: { agySeats: false } });
  const legacyOff = await boot({ huddleSeats: 'auto', agyConversations: true, huddleCfg: { geminiSeat: false } });
  const seatIds = (r) => r.body.personas.filter((p) => p.seat).map((p) => p.id);
  try {
    const a = await without.post('/api/huddle', {});
    assert.deepEqual(seatIds(a), []);
    assert.ok(a.body.notes.some((n) => /agy/.test(n)), 'the snapshot names why the seats are missing');
    assert.deepEqual(seatIds(await withIt.post('/api/huddle', {})), ['homer', 'guppy', 'medeiros']);
    assert.deepEqual(seatIds(await off.post('/api/huddle', {})), []);
    assert.deepEqual(seatIds(await legacyOff.post('/api/huddle', {})), [], 'geminiSeat: false still disables every agy seat');
  } finally { await Promise.allSettled([without.close(), withIt.close(), off.close(), legacyOff.close()]); }
});

test('unknown huddle ids answer 404; interrupt answers ok', async () => {
  const s = await boot();
  try {
    assert.equal((await s.get('/api/huddle/nope')).status, 404);
    const start = await s.post('/api/huddle', {});
    assert.deepEqual((await s.post(`/api/huddle/${start.body.id}/interrupt`, {})).body, { ok: true });
    await s.post(`/api/huddle/${start.body.id}/end`, {});
  } finally { await s.close(); }
});

test('huddle payloads reach an SSE client on /api/events', async () => {
  const s = await boot();
  const sse = openSse(s.base);
  try {
    assert.ok(await sse.waitFor((p) => p.type === 'hello'), 'the SSE client connected');
    const start = await s.post('/api/huddle', {});
    await s.post(`/api/huddle/${start.body.id}/say`, { text: 'Builder, estimate this' });
    assert.ok(await sse.waitFor((p) => p.type === 'huddle' && p.event === 'started' && p.huddleId === start.body.id));
    assert.ok(await sse.waitFor((p) => p.type === 'huddle' && p.event === 'utterance' && p.speaker === 'bill' && p.model === 'opus'));
    await s.post(`/api/huddle/${start.body.id}/end`, {});
    assert.ok(await sse.waitFor((p) => p.type === 'huddle' && p.event === 'ended'));
  } finally { await sse.close(); await s.close(); }
});

test('POST /api/huddle with a foreign Origin is 403 and starts nothing (the access guard covers the new routes)', async () => {
  const s = await boot();
  const sse = openSse(s.base);
  const started = () => readSpineEvents(s.stateDir, { kind: SPINE_KINDS.HUDDLE_STARTED }).length;
  try {
    assert.ok(await sse.waitFor((p) => p.type === 'hello'), 'the SSE client connected');
    const r = await fetch(`${s.base}/api/huddle`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' }, body: '{}' });
    assert.equal(r.status, 403);
    assert.equal(started(), 0, 'no huddle.started spine event');
    assert.equal(await sse.waitFor((p) => p.type === 'huddle' && p.event === 'started', 300), false, 'no SSE started frame');
    assert.equal((await s.post('/api/huddle', {})).status, 200, 'the same request without the foreign Origin works');
    assert.equal(started(), 1, 'the allowed request did start one (the check above can fail)');
  } finally { await sse.close(); await s.close(); }
});

test('a stale huddle is ended (spine event, summary) and dropped when the next one starts', async () => {
  const s = await boot({ huddleCfg: { staleMs: 1 } });
  try {
    const a = await s.post('/api/huddle', {});
    await new Promise((r) => setTimeout(r, 25));
    const b = await s.post('/api/huddle', {});
    assert.equal(b.status, 200);
    assert.equal((await s.get(`/api/huddle/${a.body.id}`)).status, 404, 'the stale huddle was pruned');
    assert.equal(readSpineEvents(s.stateDir, { kind: SPINE_KINDS.HUDDLE_ENDED }).length, 1);
    await s.post(`/api/huddle/${b.body.id}/end`, {});
  } finally { await s.close(); }
});

// Controller decision: say() is serialized per huddle. A second line while one
// is in flight interrupts it (a newer operator line supersedes the turn, the
// session's own rule) and then WAITS for it, so two Lead calls never overlap.
test('a second say while one is in flight waits for it: Lead calls never run concurrently for one huddle', async () => {
  let leadActive = 0;
  let leadMax = 0;
  let leadCalls = 0;
  let releaseFirst;
  const firstGate = new Promise((r) => { releaseFirst = r; });
  const stream = async (args) => {
    if (String(args.body.system).includes('hold the floor')) {
      leadCalls += 1;
      leadActive += 1;
      leadMax = Math.max(leadMax, leadActive);
      try {
        if (leadCalls === 1) await firstGate;
        else await new Promise((r) => setTimeout(r, 10));
        return { text: '{"speakers":["garfield"],"reason":"risk","ask":""}' };
      } finally { leadActive -= 1; }
    }
    return fakeStream(args);
  };
  const s = await boot({ huddleStream: stream });
  try {
    const { body: { id } } = await s.post('/api/huddle', {});
    const first = s.post(`/api/huddle/${id}/say`, { text: 'what breaks first?' });
    for (let i = 0; i < 100 && leadCalls < 1; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(leadCalls, 1, 'the first Lead call is in flight');
    const second = s.post(`/api/huddle/${id}/say`, { text: 'and what breaks second?' });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(leadCalls, 1, 'the second line has not reached the Lead while the first is in flight');
    releaseFirst();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(b.body.speakers, ['garfield']);
    assert.equal(leadMax, 1, 'never two Lead calls at once');
    const snap = await s.get(`/api/huddle/${id}`);
    const ops = snap.body.transcript.filter((u) => u.speaker === 'operator').map((u) => u.text);
    assert.deepEqual(ops, ['what breaks first?', 'and what breaks second?']);
    await s.post(`/api/huddle/${id}/end`, {});
  } finally { releaseFirst(); await s.close(); }
});

// A superseding operator line is shown at once: it is recorded and broadcast
// when POST /say arrives, not when the prior Lead call returns. The turn itself
// stays serialized behind the prior one.
test('a second say is recorded and reaches the SSE stream while the prior Lead call is still held', async () => {
  let leadCalls = 0;
  let releaseFirst;
  const firstGate = new Promise((r) => { releaseFirst = r; });
  const stream = async (args) => {
    if (String(args.body.system).includes('hold the floor')) {
      leadCalls += 1;
      if (leadCalls === 1) await firstGate;
      return { text: '{"speakers":["garfield"],"reason":"risk","ask":""}' };
    }
    return fakeStream(args);
  };
  const s = await boot({ huddleStream: stream });
  const sse = openSse(s.base);
  try {
    assert.ok(await sse.waitFor((p) => p.type === 'hello'), 'the SSE client connected');
    const { body: { id } } = await s.post('/api/huddle', {});
    const first = s.post(`/api/huddle/${id}/say`, { text: 'what breaks first?' });
    for (let i = 0; i < 100 && leadCalls < 1; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(leadCalls, 1, 'the first Lead call is held');
    const second = s.post(`/api/huddle/${id}/say`, { text: 'and what breaks second?' });
    assert.ok(await sse.waitFor((p) => p.type === 'huddle' && p.event === 'utterance' && p.speaker === 'operator' && p.text === 'and what breaks second?'), 'the superseding line reached the stream before the gate opened');
    assert.equal(leadCalls, 1, 'and its turn has not reached the Lead');
    releaseFirst();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(b.body.speakers, ['garfield']);
    const ops = (await s.get(`/api/huddle/${id}`)).body.transcript.filter((u) => u.speaker === 'operator').map((u) => u.text);
    assert.deepEqual(ops, ['what breaks first?', 'and what breaks second?'], 'each operator line is recorded once');
    await s.post(`/api/huddle/${id}/end`, {});
  } finally { releaseFirst(); await sse.close(); await s.close(); }
});

test('a say that arrives while the huddle is ending answers 409, not a 500', async () => {
  let releaseSummary;
  const summaryGate = new Promise((r) => { releaseSummary = r; });
  const stream = async (args) => {
    if (String(args.body.system).startsWith('Summarise')) { await summaryGate; return { text: 'Summary line.' }; }
    return fakeStream(args);
  };
  const s = await boot({ huddleStream: stream });
  try {
    const { body: { id } } = await s.post('/api/huddle', {});
    await s.post(`/api/huddle/${id}/say`, { text: 'Garfield, what breaks?' });
    const ending = s.post(`/api/huddle/${id}/end`, {});
    await new Promise((r) => setTimeout(r, 40));
    const late = await s.post(`/api/huddle/${id}/say`, { text: 'one more thing' });
    assert.equal(late.status, 409);
    assert.match(late.body.error, /huddle ended/);
    releaseSummary();
    assert.equal((await ending).body.ended, true);
  } finally { releaseSummary(); await s.close(); }
});

test('server close() ends an open huddle (summary and spine event) before shutting down', async () => {
  const posted = [];
  const s = await boot({ huddlePostSummary: async (text) => { posted.push(text); } });
  try {
    const { body: { id } } = await s.post('/api/huddle', {});
    await s.post(`/api/huddle/${id}/say`, { text: 'Garfield, what breaks?' });
    await s.closeServer();
    assert.deepEqual(posted, ['Summary line.']);
    assert.equal(readSpineEvents(s.stateDir, { kind: SPINE_KINDS.HUDDLE_ENDED }).length, 1);
  } finally { await s.close(); }
});

// close() must not wait on a hung huddle. The service
// restart races close() against 8 s and exits 75, so an unbounded end() would
// skip the pool close (orphan claude processes) and scut.stop(). The fake
// stream models the real pool: nothing resolves until the pool is closed,
// and closing it fails every pending and later call.
test('server close() with a hung huddle returns by the deadline and still closes the pool', { timeout: 20_000 }, async () => {
  const pending = new Set();
  let closeCalls = 0;
  let calls = 0;
  let closed = false;
  const stream = (args) => new Promise((resolve, reject) => {
    calls += 1;
    if (closed) { reject(new Error('pool closed')); return; }
    pending.add(reject);
  });
  stream.close = () => { closeCalls += 1; closed = true; for (const r of pending) r(new Error('pool closed')); pending.clear(); };
  const s = await boot({ huddleStream: stream });
  try {
    const { body: { id } } = await s.post('/api/huddle', {});
    const inflight = s.post(`/api/huddle/${id}/say`, { text: 'what breaks first?' }).catch(() => null);
    for (let i = 0; i < 200 && calls < 1; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(calls, 1, 'the Lead call is hung in flight');
    const t0 = Date.now();
    await s.closeServer();
    const ms = Date.now() - t0;
    assert.ok(ms < 5000 + 2500, `close() returned in ${ms} ms (deadline 5000 ms)`);
    assert.ok(closeCalls >= 1, 'the huddle pool was closed');
    await inflight;
  } finally { stream.close(); await s.close(); }
});

// Server close aborts a seat call in flight at once: it must not wait the
// 10 s end grace (or the agy timeout) inside the 5 s close bound.
test('server close() aborts an in-flight seat call and returns well inside the close deadline', { timeout: 20_000 }, async () => {
  let aborts = 0;
  let asked = 0;
  const stuck = fakeSeat('homer', (args) => { asked += 1; args.signal?.addEventListener('abort', () => { aborts += 1; }); return new Promise(() => {}); });
  const s = await boot({ huddleSeats: [stuck] });
  try {
    const { body: { id } } = await s.post('/api/huddle', {});
    await s.post(`/api/huddle/${id}/say`, { text: 'Builder, how long would the dock take to build?' });
    for (let i = 0; i < 200 && asked < 1; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(asked, 1, 'the seat dissent is in flight');
    const t0 = Date.now();
    await s.closeServer();
    const ms = Date.now() - t0;
    assert.equal(aborts, 1, 'the seat call was aborted');
    assert.ok(ms < 3000, `close() returned in ${ms} ms, without waiting the 5 s deadline`);
  } finally { await s.close(); }
});

test('a config that maps two personas to the same model, or names an unknown engine, starts with a status line and never crashes', async () => {
  const s = await boot({ huddleCfg: { seats: { bill: { engine: 'openai' }, garfield: { engine: 'claude', model: 'haiku' } } } });
  try {
    const start = await s.post('/api/huddle', {});
    assert.equal(start.status, 200);
    assert.ok(start.body.notes.some((n) => /bill/.test(n) && /openai/.test(n)), 'unknown engine named');
    assert.ok(start.body.notes.some((n) => /same model/.test(n)), 'duplicate model warned');
    const say = await s.post(`/api/huddle/${start.body.id}/say`, { text: 'Builder, go' });
    assert.equal(say.status, 200);
    assert.equal((await s.get(`/api/huddle/${start.body.id}`)).body.transcript[1].model, 'opus', 'a refused seat falls back to the mind model');
    await s.post(`/api/huddle/${start.body.id}/end`, {});
  } finally { await s.close(); }
});

const DECIDED = { decisions: ['Ship voice first'], actions: [{ title: 'Add the Talk button', detail: 'Talk toggles the mic.' }, { title: 'Bench first word', detail: 'Under 5 s.' }], open: [] };
const DECIDED_OUT = { problem: '', ...DECIDED, against: [''] };
const decidingStream = async (args) => {
  if (String(args.body.system).startsWith('You read a huddle transcript')) return { text: JSON.stringify(DECIDED) };
  return fakeStream(args);
};
async function decided(s) {
  const { body: { id } } = await s.post('/api/huddle', {});
  await s.post(`/api/huddle/${id}/say`, { text: 'Builder, should we ship voice first?' });
  const d = await s.post(`/api/huddle/${id}/decide`, {});
  return { id, d };
}

test('decide returns the decisions on the Sonnet default and broadcasts the decisions frame', async () => {
  const models = [];
  const stream = async (args) => { models.push([args.body.system.slice(0, 12), args.body.model]); return decidingStream(args); };
  const s = await boot({ huddleStream: stream });
  const sse = openSse(s.base);
  try {
    assert.ok(await sse.waitFor((p) => p.type === 'hello'));
    const { id, d } = await decided(s);
    assert.equal(d.status, 200);
    assert.deepEqual(d.body, DECIDED_OUT);
    assert.deepEqual(models.find(([sys]) => sys === 'You read a h'), ['You read a h', 'sonnet']);
    assert.ok(await sse.waitFor((p) => p.type === 'huddle' && p.event === 'decisions' && p.huddleId === id && p.actions.length === 2));
    assert.deepEqual((await s.get(`/api/huddle/${id}`)).body.extracted, DECIDED_OUT);
    assert.equal(readSpineEvents(s.stateDir, { kind: SPINE_KINDS.HUDDLE_DECISIONS }).length, 1);
    await s.post(`/api/huddle/${id}/end`, {});
  } finally { await sse.close(); await s.close(); }
});

test('kickoff plan + queued files one huddle-sourced queued card; the same kickoff again returns it with repeat', async () => {
  const s = await boot({ huddleStream: decidingStream });
  try {
    const { id } = await decided(s);
    const k = await s.post(`/api/huddle/${id}/kickoff`, { mode: 'plan', state: 'queued' });
    assert.equal(k.status, 200);
    assert.equal(k.body.repeat, false);
    assert.equal(k.body.cards.length, 1);
    assert.equal(k.body.cards[0].state, 'queued');
    assert.match(k.body.cards[0].title, /^Plan from huddle .+: Add the Talk button$/);
    const board = (await s.get('/api/backlog')).body.items;
    const card = board.find((i) => i.id === k.body.cards[0].id);
    assert.equal(card.source, 'huddle');
    assert.deepEqual(card.origin, { via: 'huddle', huddleId: id });
    assert.equal(card.acceptanceCriteria.length, 2);
    const again = await s.post(`/api/huddle/${id}/kickoff`, { mode: 'plan', state: 'queued' });
    assert.equal(again.body.repeat, true);
    assert.equal(again.body.cards[0].id, k.body.cards[0].id);
    assert.equal((await s.get('/api/backlog')).body.items.filter((i) => i.source === 'huddle').length, 1, 'no duplicate card');
    assert.deepEqual(readSpineEvents(s.stateDir, { kind: SPINE_KINDS.HUDDLE_KICKOFF }).map((e) => e.payload.cards), [[k.body.cards[0].id]]);
    await s.post(`/api/huddle/${id}/end`, {});
  } finally { await s.close(); }
});

test('kickoff actions files one card per pick; Backlog instead parks them (held, not queued); no picks is nothing to file', async () => {
  const s = await boot({ huddleStream: decidingStream });
  try {
    const { id } = await decided(s);
    const none = await s.post(`/api/huddle/${id}/kickoff`, { mode: 'actions', picks: [], state: 'queued' });
    assert.equal(none.status, 409);
    assert.match(none.body.error, /nothing to file/);
    const k = await s.post(`/api/huddle/${id}/kickoff`, { mode: 'actions', picks: [1, 0, 9], state: 'backlog' });
    assert.equal(k.status, 200);
    assert.deepEqual(k.body.cards.map((c) => [c.title, c.state]), [['Add the Talk button', 'held'], ['Bench first word', 'held']]);
    await s.post(`/api/huddle/${id}/end`, {});
  } finally { await s.close(); }
});

test('kickoff before decide is 409; an unknown state or mode is 400', async () => {
  const s = await boot({ huddleStream: decidingStream });
  try {
    const { body: { id } } = await s.post('/api/huddle', {});
    const early = await s.post(`/api/huddle/${id}/kickoff`, { mode: 'plan', state: 'queued' });
    assert.equal(early.status, 409);
    assert.match(early.body.error, /decide first/);
    await s.post(`/api/huddle/${id}/say`, { text: 'Builder, hi there friend' });
    await s.post(`/api/huddle/${id}/decide`, {});
    assert.equal((await s.post(`/api/huddle/${id}/kickoff`, { mode: 'plan', state: 'done' })).status, 400);
    assert.equal((await s.post(`/api/huddle/${id}/kickoff`, { mode: 'everything', state: 'queued' })).status, 400);
    await s.post(`/api/huddle/${id}/end`, {});
  } finally { await s.close(); }
});

test('a decided huddle with nothing agreed files nothing', async () => {
  const empty = async (args) => (String(args.body.system).startsWith('You read a huddle transcript') ? { text: '{"decisions":[],"actions":[],"open":[]}' } : fakeStream(args));
  const s = await boot({ huddleStream: empty });
  try {
    const { id } = await decided(s);
    const k = await s.post(`/api/huddle/${id}/kickoff`, { mode: 'plan', state: 'queued' });
    assert.equal(k.status, 409);
    assert.match(k.body.error, /nothing to file/);
    assert.equal((await s.get('/api/backlog')).body.items.filter((i) => i.source === 'huddle').length, 0);
    await s.post(`/api/huddle/${id}/end`, {});
  } finally { await s.close(); }
});

test('decide and kickoff still work after the huddle has ended', async () => {
  const s = await boot({ huddleStream: decidingStream });
  try {
    const { body: { id } } = await s.post('/api/huddle', {});
    await s.post(`/api/huddle/${id}/say`, { text: 'Builder, should we ship voice first?' });
    await s.post(`/api/huddle/${id}/end`, {});
    assert.equal((await s.get(`/api/huddle/${id}`)).status, 404, 'an ended huddle is not live');
    const d = await s.post(`/api/huddle/${id}/decide`, {});
    assert.equal(d.status, 200);
    assert.deepEqual(d.body, DECIDED_OUT);
    const k = await s.post(`/api/huddle/${id}/kickoff`, { mode: 'plan', state: 'queued' });
    assert.equal(k.status, 200);
    assert.equal(k.body.cards.length, 1);
  } finally { await s.close(); }
});

test('metric: a good voice latency is 200 and lands on the spine; a bad one is 400', async () => {
  const s = await boot();
  try {
    const { body: { id } } = await s.post('/api/huddle', {});
    assert.equal((await s.post(`/api/huddle/${id}/metric`, { kind: 'voice', heardToFirstAudioMs: 2100, speaker: 'bill' })).status, 200);
    assert.equal((await s.post(`/api/huddle/${id}/metric`, { kind: 'voice', heardToFirstAudioMs: -5 })).status, 400);
    assert.equal(readSpineEvents(s.stateDir, { kind: SPINE_KINDS.HUDDLE_METRIC }).length, 1);
    await s.post(`/api/huddle/${id}/end`, {});
  } finally { await s.close(); }
});

test('kickoff files into the named project, and the same kickoff into another project is not a repeat', async () => {
  const s = await boot({ huddleStream: decidingStream });
  try {
    const { id } = await decided(s);
    const a = await s.post(`/api/huddle/${id}/kickoff`, { mode: 'plan', state: 'backlog', project: 'harbor-app' });
    const b = await s.post(`/api/huddle/${id}/kickoff`, { mode: 'plan', state: 'backlog', project: 'glmps-2.0' });
    assert.equal(b.body.repeat, false);
    const board = (await s.get('/api/backlog')).body.items;
    assert.equal(board.find((i) => i.id === a.body.cards[0].id).project, 'harbor-app');
    assert.equal(board.find((i) => i.id === b.body.cards[0].id).project, 'glmps-2.0');
    await s.post(`/api/huddle/${id}/end`, {});
  } finally { await s.close(); }
});

// A fake card-thread opener: records what was posted and bound.
function fakeThreads({ failOpen = false } = {}) {
  const posted = [];
  const bound = [];
  let n = 0;
  return {
    posted, bound,
    available: () => true,
    open: async (text) => { if (failOpen) throw new Error('channel_not_found'); posted.push(text); n += 1; return { channel: 'C0HUB', thread_ts: `1792.00${n}` }; },
    bind: async (room) => { bound.push(room); return room; },
  };
}

test('kickoff with Slack: each card is filed with its own thread as its Slack origin and bound like a mention; a repeat opens no new thread', async () => {
  const threads = fakeThreads();
  const s = await boot({ huddleStream: decidingStream, huddleCardThreads: threads });
  try {
    const { id } = await decided(s);
    const k = await s.post(`/api/huddle/${id}/kickoff`, { mode: 'actions', picks: [0, 1], state: 'queued', project: 'glmps-2.0' });
    assert.equal(k.status, 200);
    assert.deepEqual(k.body.cards.map((c) => c.thread), ['1792.001', '1792.002']);
    assert.equal(threads.posted.length, 2);
    assert.match(threads.posted[0], new RegExp(`From huddle ${id}: `));
    const board = (await s.get('/api/backlog')).body.items;
    const card = board.find((i) => i.id === k.body.cards[0].id);
    assert.deepEqual(card.origin, { via: 'slack', channel: 'C0HUB', thread_ts: '1792.001', ts: '1792.001', user: null, agentId: 'riker', huddleId: id });
    assert.deepEqual(threads.bound.map((r) => [r.ticketId, r.thread_ts, r.project]), [[k.body.cards[0].id, '1792.001', 'glmps-2.0'], [k.body.cards[1].id, '1792.002', 'glmps-2.0']]);
    const again = await s.post(`/api/huddle/${id}/kickoff`, { mode: 'actions', picks: [0, 1], state: 'queued', project: 'glmps-2.0' });
    assert.equal(again.body.repeat, true);
    assert.equal(threads.posted.length, 2, 'no second thread');
    await s.post(`/api/huddle/${id}/end`, {});
  } finally { await s.close(); }
});

test('kickoff when the thread cannot be opened still files the card, without a thread, and says why', async () => {
  const s = await boot({ huddleStream: decidingStream, huddleCardThreads: fakeThreads({ failOpen: true }) });
  try {
    const { id } = await decided(s);
    const k = await s.post(`/api/huddle/${id}/kickoff`, { mode: 'plan', state: 'queued', project: 'glmps-2.0' });
    assert.equal(k.status, 200);
    assert.equal(k.body.cards[0].slackError, 'channel_not_found');
    assert.equal(k.body.cards[0].thread, undefined);
    const card = (await s.get('/api/backlog')).body.items.find((i) => i.id === k.body.cards[0].id);
    assert.deepEqual(card.origin, { via: 'huddle', huddleId: id });
    await s.post(`/api/huddle/${id}/end`, {});
  } finally { await s.close(); }
});

test('a spoken work command decides, files a queued plan card with its own thread, and the Lead says so; no mind is asked', async () => {
  const threads = fakeThreads();
  const systems = [];
  const stream = async (args) => { systems.push(String(args.body.system).slice(0, 20)); return decidingStream(args); };
  const s = await boot({ huddleStream: stream, huddleCardThreads: threads });
  try {
    const { body: { id } } = await s.post('/api/huddle', {});
    await s.post(`/api/huddle/${id}/say`, { text: 'Builder, should we ship voice first?' });
    const before = systems.length;
    const r = await s.post(`/api/huddle/${id}/say`, { text: 'Okay, make this work.', project: 'glmps-2.0' });
    assert.equal(r.status, 200);
    assert.equal(r.body.via, 'work');
    assert.equal(r.body.cards.length, 1);
    assert.equal(r.body.cards[0].state, 'queued');
    assert.deepEqual(systems.slice(before), ['You read a huddle tr'], 'only the decisions call ran: no floor, no mind');
    const last = (await s.get(`/api/huddle/${id}`)).body.transcript.at(-1);
    assert.equal(last.speaker, 'riker');
    assert.equal(last.text, `Queued ${r.body.cards[0].id} for the runner, each with its own Slack thread.`);
    const again = await s.post(`/api/huddle/${id}/say`, { text: 'make it work', project: 'glmps-2.0' });
    assert.equal(again.body.repeat, true);
    assert.equal(threads.posted.length, 1);
    await s.post(`/api/huddle/${id}/end`, {});
  } finally { await s.close(); }
});

test('a work command with no project files nothing and the Lead asks for one; a question about work is an ordinary turn', async () => {
  const threads = fakeThreads();
  const s = await boot({ huddleStream: decidingStream, huddleCardThreads: threads });
  try {
    const { body: { id } } = await s.post('/api/huddle', {});
    await s.post(`/api/huddle/${id}/say`, { text: 'Builder, should we ship voice first?' });
    const r = await s.post(`/api/huddle/${id}/say`, { text: 'Make this work.' });
    assert.deepEqual(r.body.cards, []);
    assert.match((await s.get(`/api/huddle/${id}`)).body.transcript.at(-1).text, /Pick a project in the dock first/);
    const q = await s.post(`/api/huddle/${id}/say`, { text: 'Does this work?', project: 'glmps-2.0' });
    assert.notEqual(q.body.via, 'work');
    assert.equal(threads.posted.length, 0);
    assert.equal((await s.get('/api/backlog')).body.items.filter((i) => i.source === 'huddle').length, 0);
    await s.post(`/api/huddle/${id}/end`, {});
  } finally { await s.close(); }
});

// Track C: mute, agenda, the four-part record, File as card, Draft spec
const RECORDED = { problem: 'Ship voice first?', decisions: [{ text: 'Ship voice first', against: 'Reviewer' }], actions: [{ title: 'Add the Talk button', detail: 'Talk toggles the mic.' }], open: ['TLS on the phone?'] };
const recordingStream = async (args) => {
  if (String(args.body.system).startsWith('You read a huddle transcript')) return { text: JSON.stringify(RECORDED) };
  return fakeStream(args);
};
const huddleCards = async (s) => (await s.get('/api/backlog')).body.items.filter((i) => i.source === 'huddle');

test('mute: POST /mute silences a seat for the floor and broadcasts it; the Lead and unknown seats are 400', async () => {
  const s = await boot({ huddleStream: fakeStream });
  const sse = openSse(s.base);
  try {
    assert.ok(await sse.waitFor((p) => p.type === 'hello'));
    const { body: { id } } = await s.post('/api/huddle', {});
    const m = await s.post(`/api/huddle/${id}/mute`, { seat: 'garfield', muted: true });
    assert.equal(m.status, 200);
    assert.deepEqual(m.body.muted, ['garfield']);
    assert.ok(await sse.waitFor((p) => p.type === 'huddle' && p.event === 'muted' && p.huddleId === id && p.muted[0] === 'garfield'));
    const say = await s.post(`/api/huddle/${id}/say`, { text: 'what breaks first?' });
    assert.ok(!say.body.speakers.includes('garfield'), 'the Lead picked garfield, but a muted seat is not scheduled');
    assert.equal((await s.post(`/api/huddle/${id}/mute`, { seat: 'riker', muted: true })).status, 400);
    assert.equal((await s.post(`/api/huddle/${id}/mute`, { seat: 'nobody', muted: true })).status, 400);
    const un = await s.post(`/api/huddle/${id}/mute`, { seat: 'garfield', muted: false });
    assert.deepEqual(un.body.muted, []);
    await s.post(`/api/huddle/${id}/end`, {});
  } finally { await sse.close(); await s.close(); }
});

test('agenda: POST /agenda returns the question and open questions and the roster carries each seat model', async () => {
  const AG = { question: 'Ship voice first?', items: [{ text: 'TLS on the phone?', lean: 'Yes' }] };
  const stream = async (args) => (String(args.body.system).startsWith('You read a huddle transcript and write its agenda') ? { text: JSON.stringify(AG) } : fakeStream(args));
  const s = await boot({ huddleStream: stream });
  try {
    const start = await s.post('/api/huddle', {});
    const id = start.body.id;
    assert.deepEqual(start.body.personas.map((p) => [p.id, p.modelName]).sort(), [['bill', 'opus'], ['garfield', 'sonnet'], ['mario', 'haiku'], ['riker', 'haiku']]);
    await s.post(`/api/huddle/${id}/say`, { text: 'Builder, should we ship voice first?' });
    const a = await s.post(`/api/huddle/${id}/agenda`, {});
    assert.equal(a.status, 200);
    assert.deepEqual(a.body, AG);
    assert.deepEqual((await s.get(`/api/huddle/${id}`)).body.agenda, AG);
    await s.post(`/api/huddle/${id}/end`, {});
  } finally { await s.close(); }
});

test('record: saves the four-part record in the state dir, live or after End, and files nothing', async () => {
  const s = await boot({ huddleStream: recordingStream });
  try {
    const { body: { id } } = await s.post('/api/huddle', {});
    await s.post(`/api/huddle/${id}/say`, { text: 'Builder, should we ship voice first?' });
    await s.post(`/api/huddle/${id}/end`, {});
    const r = await s.post(`/api/huddle/${id}/record`, {});
    assert.equal(r.status, 200);
    assert.equal(r.body.record.problem, 'Ship voice first?');
    assert.deepEqual(r.body.record.decisions, [{ text: 'Ship voice first', against: 'Reviewer' }]);
    assert.deepEqual(r.body.record.open, ['TLS on the phone?']);
    assert.equal(r.body.record.actions.length, 1);
    assert.equal(r.body.record.summary, 'Summary line.');
    const onDisk = JSON.parse(fs.readFileSync(path.join(s.stateDir, 'huddle-records', `${id}.json`), 'utf8'));
    assert.deepEqual(onDisk, r.body.record);
    assert.equal((await huddleCards(s)).length, 0, 'saving a record files no card');
  } finally { await s.close(); }
});

test('kickoff mode record files one held card whose acceptance criteria come from the decisions; a repeat does not file twice', async () => {
  const s = await boot({ huddleStream: recordingStream });
  try {
    const { body: { id } } = await s.post('/api/huddle', {});
    await s.post(`/api/huddle/${id}/say`, { text: 'Builder, should we ship voice first?' });
    await s.post(`/api/huddle/${id}/end`, {});
    assert.equal((await s.post(`/api/huddle/${id}/kickoff`, { mode: 'record', state: 'backlog', project: 'glmps-2.0' })).status, 409, 'decide first');
    await s.post(`/api/huddle/${id}/record`, {});
    const k = await s.post(`/api/huddle/${id}/kickoff`, { mode: 'record', state: 'backlog', project: 'glmps-2.0' });
    assert.equal(k.status, 200);
    assert.equal(k.body.cards[0].state, 'held');
    const card = (await huddleCards(s))[0];
    assert.equal(card.title, `Huddle ${id}: Ship voice first?`);
    assert.deepEqual(card.acceptanceCriteria.map((a) => a.text), ['AC-1 Ship voice first']);
    assert.equal((await s.post(`/api/huddle/${id}/kickoff`, { mode: 'record', state: 'backlog', project: 'glmps-2.0' })).body.repeat, true);
    assert.equal((await huddleCards(s)).length, 1);
  } finally { await s.close(); }
});

test('spec: returns a markdown draft of the record and stores it beside the record; no saved record is 409', async () => {
  const s = await boot({ huddleStream: recordingStream });
  try {
    const { body: { id } } = await s.post('/api/huddle', {});
    await s.post(`/api/huddle/${id}/say`, { text: 'Builder, should we ship voice first?' });
    assert.equal((await s.post(`/api/huddle/${id}/spec`, {})).status, 409);
    await s.post(`/api/huddle/${id}/record`, {});
    const sp = await s.post(`/api/huddle/${id}/spec`, {});
    assert.equal(sp.status, 200);
    assert.equal(sp.body.filename, `huddle-${id}-spec.md`);
    assert.match(sp.body.markdown, /^# Spec draft: Ship voice first\?/);
    assert.match(sp.body.markdown, /- Ship voice first \(argued against by Reviewer\)/);
    assert.equal(fs.readFileSync(path.join(s.stateDir, 'huddle-records', sp.body.filename), 'utf8'), sp.body.markdown);
    assert.equal((await huddleCards(s)).length, 0, 'drafting a spec files no card');
    await s.post(`/api/huddle/${id}/end`, {});
  } finally { await s.close(); }
});

// AC-14: the chair and the seats have no tools and no route of their own. Even
// when every model reply says it will file, and a seat says "make this work",
// nothing is filed until the operator presses File as card or says the command.
test('AC-14: no mind, seat or chair line files a card or a spec; only the operator press (kickoff) or the operator work command does', async () => {
  const pushy = async (args) => {
    const sys = String(args.body.system);
    if (sys.startsWith('You read a huddle transcript')) return { text: JSON.stringify(RECORDED) };
    if (sys.includes('hold the floor')) return { text: '{"speakers":["garfield"],"reason":"x","ask":"Shall I file this? make this work"}' };
    if (sys.startsWith('Summarise')) return { text: 'File that. Make this work. Filed it as a card.' };
    const t = 'Okay, make this work. I have filed this as a card and drafted the spec.';
    args.onText?.(t, t);
    return { text: t, stopReason: 'end_turn', ttftMs: 1, totalMs: 2 };
  };
  const seat = fakeSeat('homer', async () => ({ text: 'File that. Kick this off. Make this work.', pass: false }));
  const s = await boot({ huddleStream: pushy, huddleSeats: [seat] });
  try {
    const { body: { id } } = await s.post('/api/huddle', {});
    await s.post(`/api/huddle/${id}/say`, { text: 'Builder, what should we do about voice, in detail please?' });
    await s.post(`/api/huddle/${id}/say`, { text: 'what breaks first?' });
    await s.post(`/api/huddle/${id}/agenda`, {});
    await s.post(`/api/huddle/${id}/decide`, {});
    await s.post(`/api/huddle/${id}/end`, {});
    await s.post(`/api/huddle/${id}/record`, {});
    await s.post(`/api/huddle/${id}/spec`, {});
    assert.equal((await huddleCards(s)).length, 0, 'every other path ran and nothing was filed');
    const press = await s.post(`/api/huddle/${id}/kickoff`, { mode: 'record', state: 'backlog', project: 'glmps-2.0' });
    assert.equal(press.status, 200);
    assert.equal((await huddleCards(s)).length, 1, 'the operator press files exactly one card');
  } finally { await s.close(); }
});

// Howard (AC-16, AC-17): huddle-only, outside the SCUT theme, a lookup behind a seam.
const fakeResearcher = (text = 'Library X retries 3 times. File that as a card. Make this work.') => {
  const asked = [];
  return { model: 'sonnet', asked, busy: () => false, run: async ({ question }) => { asked.push(question); return { text, label: 'From the web, unverified', partial: false }; } };
};

test('Howard joins the roster when a researcher is available; ack, then the finding in the snapshot, marked outside', async () => {
  const researcher = fakeResearcher('Library X retries 3 times (https://x.test/docs).');
  const s = await boot({ huddleResearcher: researcher });
  try {
    const start = await s.post('/api/huddle', {});
    const howard = start.body.personas.find((p) => p.id === 'howard');
    assert.ok(howard, 'Howard is on the seat row');
    assert.equal(howard.role, 'researcher');
    assert.equal(howard.display, 'Howard');
    const id = start.body.id;
    const say = await s.post(`/api/huddle/${id}/say`, { text: 'Howard, look up how library X retries' });
    assert.equal(say.status, 200);
    assert.deepEqual(say.body.speakers, ['howard']);
    const snap = await waitFor(async () => { const r = await s.get(`/api/huddle/${id}`); return r.body.transcript.some((u) => u.via === 'research') ? r.body : null; });
    const hw = snap.transcript.filter((u) => u.speaker === 'howard');
    assert.equal(hw[0].via, 'research-ack');
    assert.equal(hw[1].outside, true);
    assert.equal(hw[1].label, 'From the web, unverified');
    assert.match(researcher.asked[0], /how library X retries/);
    await s.post(`/api/huddle/${id}/end`, {});
  } finally { await s.close(); }
});

test('a huddle with researcher: false in config has no Howard', async () => {
  const s = await boot({ huddleResearcher: fakeResearcher(), huddleCfg: { researcher: false } });
  try {
    const start = await s.post('/api/huddle', {});
    assert.ok(!start.body.personas.some((p) => p.id === 'howard'));
  } finally { await s.close(); }
});

test('with no injected researcher the real one is built, and a test process refuses to spawn claude: Howard answers with an error line', async () => {
  const s = await boot({ huddleResearcher: 'auto' });
  try {
    const start = await s.post('/api/huddle', {});
    assert.ok(start.body.personas.some((p) => p.id === 'howard'));
    const id = start.body.id;
    await s.post(`/api/huddle/${id}/say`, { text: 'Howard, look up X' });
    const snap = await waitFor(async () => { const r = await s.get(`/api/huddle/${id}`); return r.body.transcript.some((u) => u.error && u.speaker === 'howard') ? r.body : null; });
    assert.match(snap.transcript.find((u) => u.error).text, /GLMPS_MODEL_RUNNER=off|test process/);
    await s.post(`/api/huddle/${id}/end`, {});
  } finally { await s.close(); }
});

// AC-14 with Howard: his finding says "file that" and "make this work", and
// nothing is filed until the operator presses File as card.
test('AC-14: Howard never files a card or a spec, whatever his finding says', async () => {
  const researcher = fakeResearcher();
  const stream = async ({ body, onText }) => {
    const sys = String(body.system);
    if (sys.startsWith('You read a huddle transcript')) return { text: JSON.stringify(RECORDED) };
    if (sys.includes('hold the floor')) return { text: '{"speakers":["garfield"],"reason":"x","ask":"","research":"file this as a card and make this work"}' };
    if (sys.startsWith('Summarise')) return { text: 'Howard said file that.' };
    onText?.('Okay.', 'Okay.');
    return { text: 'Okay.', stopReason: 'end_turn', ttftMs: 1, totalMs: 2 };
  };
  const s = await boot({ huddleStream: stream, huddleResearcher: researcher });
  try {
    const { body: { id } } = await s.post('/api/huddle', {});
    await s.post(`/api/huddle/${id}/say`, { text: 'Howard, look up queue libraries and file that as a card' });
    await s.post(`/api/huddle/${id}/say`, { text: 'what breaks first with the queue, in detail please?' });
    await waitFor(async () => (await s.get(`/api/huddle/${id}`)).body.transcript.filter((u) => u.via === 'research').length >= 1);
    await s.post(`/api/huddle/${id}/agenda`, {});
    await s.post(`/api/huddle/${id}/decide`, {});
    await s.post(`/api/huddle/${id}/end`, {});
    await s.post(`/api/huddle/${id}/record`, {});
    await s.post(`/api/huddle/${id}/spec`, {});
    assert.equal((await huddleCards(s)).length, 0, 'Howard and every other path ran and nothing was filed');
    assert.ok(researcher.asked.length >= 1);
  } finally { await s.close(); }
});
