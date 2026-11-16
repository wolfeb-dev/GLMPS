// npm run smoke: build the tap into a temp dir, then run every entry twice,
// from the checkout with this Node and from the bundle with the pinned
// node.exe (this Node off Windows), on the same input in a fresh sandbox
// each time. Exit code, stdout and stderr must match once the two roots and
// the sandbox path are masked. The board points at port 1, so nothing here
// reaches a live kernel.
//
// The tap agent is not fed hook input: it is a long-running process, so it gets
// its own case, run on Windows only because its token file is DPAPI. The
// bundled agent runs under the pinned node.exe against a throwaway server
// with a paired client; its one heartbeat and /tap/status are checked, then
// one card and one devlog are posted through its relay port.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { HOOK_MANIFEST } from '../../../scripts/install-hooks-lib.mjs';
import { openClientStore } from '../../../server/lib/kernel/clients.js';
import { dbFileFor } from '../../../server/lib/state-dir.js';
import { startServer } from '../../../server/server.js';
import { openTapIngest } from '../../../server/lib/kernel/tap-ingest.js';
import { writeToken } from '../../../taps/tap-token.js';
import { buildTap } from '../scripts/build-tap.mjs';
import { INSTALLER_ENTRIES, STATUSLINE_TAP, TAP_AGENT, tapEntries } from '../scripts/bundle-lib.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

function inputFor(entry, sandbox) {
  const cwd = path.join(sandbox, 'work');
  const base = { session_id: 'tap-smoke', cwd, transcript_path: path.join(sandbox, 'missing.jsonl') };
  if (entry === STATUSLINE_TAP) return { ...base, model: { display_name: 'smoke' }, cost: { total_cost_usd: 0 } };
  const row = HOOK_MANIFEST.find((r) => `${r.dir || 'hooks'}/${r.script}` === entry);
  if (!row) return {};
  const ev = { ...base, hook_event_name: row.event };
  if (row.event === 'PreToolUse' || row.event === 'PostToolUse') {
    const tool = row.matcher.split('|').find((t) => t !== '*') || 'Bash';
    ev.tool_name = tool;
    ev.tool_input = tool === 'Bash' ? { command: 'echo tap-smoke' } : { file_path: path.join(cwd, 'a.txt'), content: 'tap smoke' };
    if (row.event === 'PostToolUse') ev.tool_response = { stdout: 'tap-smoke', stderr: '' };
  }
  if (row.event === 'UserPromptSubmit') ev.prompt = 'tap smoke';
  return ev;
}

// Beyond each entry's quiet path: one deny, so a guard's refusal (and the
// inlined lib that decides it) is compared too. The character is built at
// run time because the no-emdash hook refuses it in a source write.
const EM_DASH = String.fromCharCode(0x2014);
const EXTRA_CASES = [
  { entry: 'hooks/no-emdash.js', name: 'deny', patch: (ev) => ({ ...ev, tool_input: { ...ev.tool_input, content: `a ${EM_DASH} b` } }) },
];

function run(node, script, entry, patch = (ev) => ev) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-smoke-'));
  for (const d of ['home', 'state', 'claude', 'work']) fs.mkdirSync(path.join(sandbox, d));
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(),
    HOME: path.join(sandbox, 'home'), USERPROFILE: path.join(sandbox, 'home'),
    GLMPS_STATE_DIR: path.join(sandbox, 'state'), GLMPS_CLAUDE_DIR: path.join(sandbox, 'claude'),
    CLAUDE_CONFIG_DIR: path.join(sandbox, 'claude'),
    GLMPS_PORT: '1', GLMPS_BOARD_URL: 'http://127.0.0.1:1',
  };
  // spawn would pass an unset one (SystemRoot off Windows) as the string "undefined".
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const r = spawnSync(node, [script], {
    input: JSON.stringify(patch(inputFor(entry, sandbox))), env, cwd: path.join(sandbox, 'work'), encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5 });
  const mask = (s) => String(s ?? '').split(sandbox).join('<sandbox>').split(path.dirname(path.dirname(script))).join('<root>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<ts>');
  return { status: r.status, signal: r.signal, stdout: mask(r.stdout), stderr: mask(r.stderr), error: r.error?.message };
}

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
async function status(port) {
  try { return await (await fetch(`http://127.0.0.1:${port}/tap/status`)).json(); } catch { return null; }
}

// Returns an error string, or null when the bundled agent sent one heartbeat
// that the server recorded, its /tap/status reports paired, and a devlog
// posted to its relay port landed on the server. It also checks the budget
// collector: a Claude dir with a sentinel refresh token and no access token (so
// no usage call is made) must yield a budget record and no trace of the sentinel.
const SENTINEL = 'SMOKE-SENTINEL-REFRESH-5d2e8c';
async function agentCase(bundledNode, outDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-agent-smoke-'));
  const claude = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claude, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claude, '.claude-manager', 'active-sessions.json'), '[]');
  const stateDir = path.join(tmp, 'state');
  const srv = await startServer({ port: 0, pollMs: 1000, env: {
    GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: stateDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini'),
    GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode'), GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
    GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot'), GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'),
    GLMPS_UNMERGED_SCAN: 'off',
  } });
  const store = openClientStore({ dbFile: dbFileFor(stateDir) });
  let child = null;
  try {
    const { clientId, token } = store.pair({ name: 'smoke', actor: 'tap-smoke' });
    const home = path.join(tmp, 'tap-home');
    fs.mkdirSync(home);
    const port = await freePort();
    fs.writeFileSync(path.join(home, 'tap-config.json'), JSON.stringify({ server: `http://127.0.0.1:${srv.port}`, clientId, name: 'smoke', port }));
    writeToken(home, token);
    const agentClaude = path.join(tmp, 'agent-claude');
    fs.mkdirSync(agentClaude);
    fs.writeFileSync(path.join(agentClaude, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: SENTINEL, subscriptionType: 'max' } }));
    child = spawn(bundledNode, [path.join(outDir, TAP_AGENT)], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GLMPS_TAP_HOME: home, GLMPS_CLAUDE_DIR: agentClaude, HOME: tmp, USERPROFILE: tmp },
      stdio: 'ignore', windowsHide: true,
    });
    let doc = null;
    for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
      doc = await status(port);
      if (doc && doc.state !== 'offline' && doc.lastHeartbeatTs) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!doc) return 'the bundled agent never answered /tap/status';
    if (doc.state !== 'paired') return `/tap/status state is ${doc.state} (${doc.reason})`;
    if (JSON.stringify(doc).includes(token)) return '/tap/status leaked the token';
    const c = store.get(clientId);
    if (!c.lastSeenTs) return 'the server recorded no heartbeat';
    console.log(`agent  ${TAP_AGENT}  /tap/status paired, server last seen ${new Date(c.lastSeenTs).toISOString()}, tapVersion ${c.tapVersion}`);
    const post = (p, body) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const card = await (await post('/api/backlog', { title: 'tap relay smoke', prompt: 'p', project: 'tap-smoke' })).json();
    const id = card?.id ?? card?.item?.id;
    if (!id) return `creating a card through the relay answered ${JSON.stringify(card)}`;
    const dl = await post(`/api/backlog/${encodeURIComponent(id)}/devlog`, { by: 'agent', text: 'tap relay smoke devlog' });
    if (dl.status >= 300) return `a devlog through the relay answered ${dl.status}`;
    const landed = await (await fetch(`http://127.0.0.1:${srv.port}/api/backlog/${encodeURIComponent(id)}`)).text();
    if (!landed.includes('tap relay smoke devlog')) return 'the devlog posted through the relay is not on the server';
    console.log(`relay  ${TAP_AGENT}  card ${id} and its devlog reached the server through 127.0.0.1:${port}`);
    const ing = openTapIngest({ dbFile: dbFileFor(stateDir) });
    try {
      let rows = [];
      for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
        rows = ing.records({ clientId });
        if (rows.some((x) => x.kind === 'budget')) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!rows.some((x) => x.kind === 'budget')) return 'no budget record from the bundled agent reached the server';
      if (JSON.stringify(rows).includes(SENTINEL)) return 'the credentials sentinel reached the server records';
    } finally { ing.closeDb(); }
    const spoolDir = path.join(home, 'spool');
    const spooled = fs.existsSync(spoolDir) ? fs.readdirSync(spoolDir).map((f) => fs.readFileSync(path.join(spoolDir, f), 'utf8')).join('') : '';
    if (spooled.includes(SENTINEL)) return 'the credentials sentinel is in the spool';
    if ((await (await fetch(`http://127.0.0.1:${srv.port}/api/budget`)).text()).includes(SENTINEL)) return 'the credentials sentinel is in /api/budget';
    console.log(`budget ${TAP_AGENT}  a budget record reached the server; the credentials sentinel is in no record, spool or /api/budget`);
    return null;
  } finally {
    child?.kill();
    store.closeDb();
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  }
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-build-'));
try {
  await buildTap({ outDir, untested: true });
  const bundledNode = process.platform === 'win32' ? path.join(outDir, 'node.exe') : process.execPath;
  const v = spawnSync(bundledNode, ['--version'], { encoding: 'utf8' }).stdout.trim();
  console.log(`bundle node: ${v} (${bundledNode === process.execPath ? 'system' : 'pinned node.exe'}); source node: ${process.version}`);
  const cases = [...tapEntries().filter((e) => e !== TAP_AGENT && !INSTALLER_ENTRIES.includes(e)).map((entry) => ({ entry, name: 'quiet' })), ...EXTRA_CASES];
  let failed = 0;
  for (const { entry, name, patch } of cases) {
    const src = run(process.execPath, path.join(REPO_ROOT, entry), entry, patch);
    const bun = run(bundledNode, path.join(outDir, entry), entry, patch);
    const same = src.status === bun.status && src.stdout === bun.stdout && src.stderr === bun.stderr && !src.error && !bun.error;
    if (!same) failed++;
    console.log(`${same ? 'same' : 'DIFF'}  ${entry} (${name})  exit ${src.status}/${bun.status}  out ${src.stdout.length}/${bun.stdout.length}B`);
    if (!same) console.log(JSON.stringify({ src, bun }, null, 2));
  }
  console.log(`${cases.length - failed} of ${cases.length} cases (${tapEntries().length - 1 - INSTALLER_ENTRIES.length} hook entries) behave the same from the bundle`);
  if (process.platform === 'win32') {
    const err = await agentCase(bundledNode, outDir);
    if (err) { failed++; console.log(`DIFF  ${TAP_AGENT} (agent): ${err}`); }
  } else {
    console.log(`skip  ${TAP_AGENT} (agent): its token file is DPAPI, so the agent case runs on Windows only`);
  }
  process.exitCode = failed ? 1 : 0;
} finally {
  fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 5 });
}
