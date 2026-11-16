// server/test/tap-git-e2e.test.js
// Git summaries end to end (card glmps-2-0-runtime-40): a real server on temp
// dirs, a paired client, and the real tap agent reading a real git repo on the
// "client". The summary arrives under the client id with credentials stripped,
// the server clones the remote (a local bare repo stands in for GitHub through
// the test seam; canonicalRemote itself still refuses file:// and local paths),
// the log route answers from the server's copy, "pushed" follows the copy, and
// the client repo's path never becomes a server repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openClientStore } from '../lib/kernel/clients.js';
import { openTapGit, canonicalRemote } from '../lib/kernel/tap-git.js';
import { getPaths } from '../lib/paths.js';
import { startServer } from '../server.js';
import { startAgent } from '../../taps/tap-agent.js';
import { waitFor } from './helpers/wait-for.js';
import { dbFileFor } from '../lib/state-dir.js';

let sqliteOk = true;
try { if (!process.getBuiltinModule('node:sqlite')?.DatabaseSync) sqliteOk = false; } catch { sqliteOk = false; }
const SKIP = sqliteOk ? false : 'node:sqlite is unavailable on this Node, so kernel.db cannot open';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const mkTmp = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `mc-tapgite2e-${tag}-`)); tmpDirs.push(d); return d; };
const emptyConfig = path.join(mkTmp('gitcfg'), 'empty');
fs.writeFileSync(emptyConfig, '');
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
const getJson = async (url) => (await fetch(url)).json();
const fwd = (p) => p.replace(/\\/g, '/');

function serverEnv() {
  const tmp = mkTmp('srv');
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  return { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'), GLMPS_UNMERGED_SCAN: 'off' };
}
function clientPaths() {
  const base = mkTmp('client');
  return getPaths({ GLMPS_CLAUDE_DIR: path.join(base, '.claude'), GLMPS_ANTIGRAVITY_DIR: path.join(base, 'ag'), GLMPS_STATE_DIR: path.join(base, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(base, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(base, 'vscode'), GLMPS_AGY_CLI_DIR: path.join(base, '.gemini', 'antigravity-cli'),
    GLMPS_CODEX_DIR: path.join(base, '.codex'), GLMPS_COPILOT_CLI_DIR: path.join(base, '.copilot'), GLMPS_HERMES_DIR: path.join(base, 'hermes'), GLMPS_OPENCODE_DIR: path.join(base, 'opencode') });
}

test('a client repo summary arrives, the server clones its remote, and history and pushed come from the server copy', { skip: SKIP }, async () => {
  const env = serverEnv();
  const bare = path.join(mkTmp('bare'), 'widgets.git');
  const urlFor = (canon) => (canon.key === 'github.com/Acme/widgets' ? bare : canon.url);
  const srv = await startServer({ port: 0, pollMs: 50, env, tapGitCloneUrlFor: urlFor });
  const base = `http://127.0.0.1:${srv.port}`;
  const dbFile = dbFileFor(env.GLMPS_STATE_DIR);
  const store = openClientStore({ dbFile });
  const inspect = openTapGit({ dbFile });
  const P = clientPaths();
  const home = mkTmp('home');
  const root = mkTmp('root');
  const proj = fwd(path.join(root, 'proj'));
  let agent;
  try {
    fs.mkdirSync(proj, { recursive: true });
    git(proj, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(proj, 'a.txt'), '1');
    git(proj, 'add', '.'); git(proj, 'commit', '-q', '-m', 'first commit');
    git(proj, 'remote', 'add', 'origin', 'https://me:supersecret@github.com/Acme/widgets.git');
    git(root, 'clone', '-q', '--bare', proj, bare);
    const head1 = git(proj, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(proj, 'dirty.txt'), 'x');

    const { clientId, token } = store.pair({ name: 'laptop', actor: 'test' });
    fs.writeFileSync(path.join(home, 'tap-config.json'), JSON.stringify({ server: base, clientId, name: 'laptop', repoRoots: [root] }));
    // A client session whose cwd is the repo: the server must neither run git there nor adopt it as a repo root.
    const transcript = path.join(P.claudeDir, 'projects', 'proj', 'sessG.jsonl');
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), cwd: proj, message: { content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'a:b' } }] } })}\n`);
    fs.mkdirSync(path.join(P.claudeDir, '.claude-manager'), { recursive: true });
    fs.writeFileSync(path.join(P.claudeDir, '.claude-manager', 'active-sessions.json'), JSON.stringify([{ sessionId: 'sessG', ppid: process.pid, cwd: proj, ts: Date.now() }]));

    agent = await startAgent({ home, port: 0, homeDir: mkTmp('user'), intervalMs: 3_600_000, log: () => {}, readToken: () => token, paths: () => P, mirrorTickMs: 40, gitTickMs: 40 });
    await agent.ready;

    const rows = await waitFor(() => { const r = inspect.list(clientId); return r.length ? r : null; }, { timeoutMs: 20_000 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, proj);
    assert.equal(rows[0].branch, 'main');
    assert.equal(rows[0].head, head1);
    assert.equal(rows[0].dirty, 1);
    assert.equal(rows[0].remote, 'https://github.com/Acme/widgets.git', 'credentials stripped');
    assert.equal(canonicalRemote('file:///x'), null);

    const status = await getJson(`http://127.0.0.1:${agent.address.port}/tap/status`);
    assert.equal(status.git.repos, 1);
    assert.ok(status.git.lastPostTs > 0);
    assert.equal(JSON.stringify(status).includes('supersecret'), false);
    assert.equal(JSON.stringify(status).includes(token), false);

    const sid = `${clientId}:sessG`;
    const onBoard = await waitFor(async () => (((await getJson(`${base}/api/state`)).board?.rows ?? []).find((r) => r.id === sid && r.git)) ?? null, { timeoutMs: 20_000 });
    assert.equal(onBoard.git.dirty, 1, 'the board row is the client summary');
    assert.equal(onBoard.git.branch, 'main');

    const projects = await getJson(`${base}/api/projects`);
    assert.equal(JSON.stringify(projects).toLowerCase().replace(/\\/g, '/').includes(path.basename(root).toLowerCase()), false, 'the client repo path is not a server repo root');

    assert.equal((await srv.loopRegistry.runNow('tap-git-clones', {})).outcome, 'done');
    const dest = path.join(env.GLMPS_STATE_DIR, 'git-clones', 'github.com', 'Acme', 'widgets.git');
    assert.ok(fs.existsSync(path.join(dest, 'HEAD')), 'the server cloned the remote');
    const listed = await getJson(`${base}/api/clients/${clientId}/git`);
    assert.equal(listed.repos[0].history.source, 'clone');
    assert.equal(listed.repos[0].pushed, true);
    const log = await getJson(`${base}/api/clients/${clientId}/git/log?path=${encodeURIComponent(proj)}`);
    assert.deepEqual(log.commits.map((c) => c.subject), ['first commit']);
    assert.equal(log.commits[0].sha, head1);

    // A local commit the remote never saw: the next summary has a new head, and the server copy cannot contain it.
    git(proj, 'add', '.'); git(proj, 'commit', '-q', '-m', 'local only');
    const head2 = git(proj, 'rev-parse', 'HEAD');
    await waitFor(() => inspect.list(clientId)[0]?.head === head2, { timeoutMs: 20_000 });
    assert.equal((await srv.loopRegistry.runNow('tap-git-clones', {})).outcome, 'done');
    const after = await getJson(`${base}/api/clients/${clientId}/git`);
    assert.equal(after.repos[0].pushed, false);
    assert.deepEqual((await getJson(`${base}/api/clients/${clientId}/git/log?path=${encodeURIComponent(proj)}`)).commits.map((c) => c.subject), ['first commit']);
  } finally {
    await agent?.close();
    inspect.closeDb(); store.closeDb(); await srv.close();
  }
});
