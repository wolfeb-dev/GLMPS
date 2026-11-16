// server/test/scut-channel-launch.test.js
// Pure launch planning for the SCUT Slack channel (server/lib/scut/channel-launch.js):
// which jobs get a channel, what MCP config that channel needs, and what gets
// appended to the seeded `claude` command line. No filesystem, no spawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
import { channelLaunchPlan, appendArgs, resolveInterpreter, mergeApproval } from '../lib/scut/channel-launch.js';

const slackJob = (over = {}) => ({
  id: 'mc-42',
  origin: { via: 'slack', channel: 'C1', thread_ts: '100.5', agentId: 'riker' },
  ...over,
});
// `enabled` is opt-in (see the default-off tests at the bottom of this file);
// every test that asserts what a plan LOOKS like has to turn it on first.
const opts = { stateDir: '/state', cwd: '/wt/glmps-42', serverPath: '/repo/server/lib/scut/channel-server.js', enabled: true };

test('no plan for a job that did not come from Slack', () => {
  assert.equal(channelLaunchPlan({ job: { id: 'a', origin: { via: 'other', chatId: 'x' } }, ...opts }), null);
  assert.equal(channelLaunchPlan({ job: { id: 'a' }, ...opts }), null);
  assert.equal(channelLaunchPlan({ job: { id: 'a', origin: null }, ...opts }), null);
});

test('no plan when the Slack origin is missing the thread it would bind to', () => {
  // Without both, a channel server would poll nothing or poll the wrong thread.
  assert.equal(channelLaunchPlan({ job: slackJob({ origin: { via: 'slack', channel: 'C1' } }), ...opts }), null);
  assert.equal(channelLaunchPlan({ job: slackJob({ origin: { via: 'slack', thread_ts: '1' } }), ...opts }), null);
});

test('a slack job gets a channel bound to exactly its own thread', () => {
  const plan = channelLaunchPlan({ job: slackJob(), ...opts });
  const srv = plan.config.mcpServers['scut-slack'];
  assert.equal(srv.args[0], '/repo/server/lib/scut/channel-server.js');
  assert.equal(srv.env.SCUT_CHANNEL, 'C1');
  assert.equal(srv.env.SCUT_THREAD_TS, '100.5');
  assert.equal(srv.env.SCUT_AGENT_ID, 'riker');
});

test('the plan passes the state dir through so the channel finds the same creds file', () => {
  // The token is read by the CHILD at runtime from the creds file - it is never
  // written into the generated config, which lands on disk unencrypted.
  const plan = channelLaunchPlan({ job: slackJob(), ...opts });
  const srv = plan.config.mcpServers['scut-slack'];
  assert.equal(srv.env.GLMPS_STATE_DIR, '/state');
  const serialized = JSON.stringify(plan.config);
  assert.equal(/xoxb|xapp|token|secret/i.test(serialized), false, 'no credential material in the generated config');
});

test('appendArgs quotes paths so a spaced directory does not split the command', () => {
  const out = appendArgs('claude "do the thing"', ['--mcp-config', 'C:/Program Files/x.json', '--channels', 'server:scut-slack']);
  assert.equal(out, 'claude "do the thing" --mcp-config "C:/Program Files/x.json" --channels server:scut-slack');
});

test('appendArgs quotes a BACKSLASH path, which a POSIX shell would otherwise eat', () => {
  // The seeded command is typed into a terminal, and on this machine that
  // terminal is Git Bash. An unquoted C:\Users\op\... arrives as
  // C:Usersop... because every backslash is read as an escape - which is
  // exactly how glmps-43 failed to launch ("MCP config file not
  // found: ...Usersop.glmpsscutchannels..."). Quoting preserves
  // them: inside double quotes bash leaves \U alone.
  const p = 'C:\\Users\\op\\.glmps\\scut\\channels\\mc-43.json';
  const out = appendArgs('claude "x"', ['--mcp-config', p]);
  assert.equal(out, `claude "x" --mcp-config "${p}"`);
});

test('appendArgs leaves ordinary flag tokens unquoted', () => {
  assert.equal(appendArgs('claude "x"', ['--channels', 'server:scut-slack']), 'claude "x" --channels server:scut-slack');
});

test('appendArgs returns the command untouched when there is nothing to append', () => {
  assert.equal(appendArgs('claude "x"', []), 'claude "x"');
  assert.equal(appendArgs('claude "x"', null), 'claude "x"');
});

// glmps-43: the channel never connected in the first live test.
// The GLMPS server is started by the Antigravity IDE binary running as node
// (ELECTRON_RUN_AS_NODE=1), so process.execPath is "Antigravity IDE.exe", and
// copying it into the MCP config spawns the IDE, not a node script: the child
// never speaks JSON-RPC and Claude Code logs
// "Connection failed after 3014ms (-32000): Connection closed".
test('an Electron host keeps its own binary but tells it to run as node', () => {
  const host = { execPath: 'C:/Users/w/AppData/Local/Programs/Antigravity IDE/Antigravity IDE.exe', electron: '39.2.3' };
  const r = resolveInterpreter(host);
  assert.equal(r.command, host.execPath, 'the running binary is the one interpreter we know exists');
  assert.equal(r.env.ELECTRON_RUN_AS_NODE, '1');
});

test('a plain node host needs no extra environment', () => {
  const r = resolveInterpreter({ execPath: 'C:/Program Files/nodejs/node.exe', electron: undefined });
  assert.equal(r.command, 'C:/Program Files/nodejs/node.exe');
  assert.equal('ELECTRON_RUN_AS_NODE' in r.env, false);
  assert.equal(resolveInterpreter({ execPath: '/usr/local/bin/node' }).command, '/usr/local/bin/node');
});

test('an unrecognised host falls back to node on PATH rather than spawning itself', () => {
  // Not node, not Electron: re-running this binary would repeat the mission-
  // control-43 failure. PATH is the only remaining guess, and a wrong guess
  // fails loudly at spawn instead of silently launching a GUI.
  const r = resolveInterpreter({ execPath: 'C:/tools/some-host.exe', electron: undefined });
  assert.equal(r.command, 'node');
  assert.equal('ELECTRON_RUN_AS_NODE' in r.env, false);
});

test('the generated config is runnable by the interpreter it names', () => {
  const plan = channelLaunchPlan({
    job: slackJob(),
    ...opts,
    host: { execPath: 'C:/Users/w/AppData/Local/Programs/Antigravity IDE/Antigravity IDE.exe', electron: '39.2.3' },
  });
  const srv = plan.config.mcpServers['scut-slack'];
  assert.equal(srv.command, 'C:/Users/w/AppData/Local/Programs/Antigravity IDE/Antigravity IDE.exe');
  assert.equal(srv.env.ELECTRON_RUN_AS_NODE, '1');
  // The channel's own wiring must survive the interpreter fix.
  assert.equal(srv.env.SCUT_CHANNEL, 'C1');
  assert.equal(srv.args[0], '/repo/server/lib/scut/channel-server.js');
});

test('an explicit nodeBin still wins and carries no Electron flag', () => {
  const plan = channelLaunchPlan({ job: slackJob(), ...opts, nodeBin: '/usr/bin/node' });
  const srv = plan.config.mcpServers['scut-slack'];
  assert.equal(srv.command, '/usr/bin/node');
  assert.equal('ELECTRON_RUN_AS_NODE' in srv.env, false);
});

test('agent id defaults rather than emitting an undefined env value', () => {
  const plan = channelLaunchPlan({ job: slackJob({ origin: { via: 'slack', channel: 'C1', thread_ts: '1' } }), ...opts });
  assert.equal(typeof plan.config.mcpServers['scut-slack'].env.SCUT_AGENT_ID, 'string');
  assert.ok(plan.config.mcpServers['scut-slack'].env.SCUT_AGENT_ID.length > 0);
});

// The first live session reported TWO errors in its header:
//   server:scut-slack - no MCP server configured with that name
//   server:scut-slack - server: entries need --dangerously-load-development-channels
// The MCP server itself connected fine, so the failure was channel REGISTRATION:
// the resolver looks a `server:` channel up in the persisted config scopes
// (enterprise/user/project/local), and a server supplied via --mcp-config is in
// none of them. The fix is to write the job's server into its worktree's
// project-scope .mcp.json, and to pass the development-channels flag.

test('the server is written to the worktree .mcp.json, not a state-dir config', () => {
  const plan = channelLaunchPlan({ job: slackJob(), ...opts });
  assert.equal(plan.configPath, '/wt/glmps-42/.mcp.json');
  assert.ok(plan.config.mcpServers['scut-slack'], 'the server is under mcpServers');
});

test('the launch args carry the development-channels flag and no --mcp-config', () => {
  const plan = channelLaunchPlan({ job: slackJob(), ...opts });
  assert.deepEqual(plan.args, [
    '--channels', 'server:scut-slack',
    '--dangerously-load-development-channels', 'server:scut-slack',
  ]);
  assert.equal(plan.args.includes('--mcp-config'), false, 'an --mcp-config server is invisible to the channel resolver');
});

test('the development-channels flag NAMES the entry it is allowlisting', () => {
  // It is `--dangerously-load-development-channels <servers...>`, an allowlist,
  // not a boolean. Passed bare it swallowed whatever followed (or errored
  // "argument missing") and glmps-45 could not open Claude at all.
  // The CLI's own wording: "<x> is not on the approved channels allowlist (use
  // --dangerously-load-development-channels for local dev)".
  const args = channelLaunchPlan({ job: slackJob(), ...opts }).args;
  const at = args.indexOf('--dangerously-load-development-channels');
  assert.notEqual(at, -1);
  assert.equal(args[at + 1], 'server:scut-slack', 'the flag must be followed by the entry it allows');
  assert.equal(at + 1 < args.length, true, 'never last: a bare trailing flag has no value to take');
});

test('every channel entry named by --channels is also on the dev allowlist', () => {
  // A `server:` entry that is enabled but not allowlisted is refused with
  // "server: entries need --dangerously-load-development-channels".
  const args = channelLaunchPlan({ job: slackJob(), ...opts }).args;
  const valuesAfter = (flag) => {
    const out = [];
    for (let i = args.indexOf(flag) + 1; i < args.length && !args[i].startsWith('--'); i += 1) out.push(args[i]);
    return out;
  };
  assert.deepEqual(valuesAfter('--channels'), valuesAfter('--dangerously-load-development-channels'));
});

test('two jobs in different worktrees get independent .mcp.json files', () => {
  const a = channelLaunchPlan({ job: slackJob({ id: 'mc-1' }), ...opts, cwd: '/wt/a' });
  const b = channelLaunchPlan({ job: slackJob({ id: 'mc-2' }), ...opts, cwd: '/wt/b' });
  assert.notEqual(a.configPath, b.configPath);
  assert.equal(a.config.mcpServers['scut-slack'].env.SCUT_TICKET, 'mc-1');
  assert.equal(b.config.mcpServers['scut-slack'].env.SCUT_TICKET, 'mc-2');
});

test('the config path uses forward slashes so no shell or JSON escape can maul it', () => {
  const plan = channelLaunchPlan({ job: slackJob(), ...opts, cwd: 'C:\\wt\\glmps-42' });
  assert.equal(plan.configPath.includes('\\'), false, plan.configPath);
  assert.equal(plan.configPath, 'C:/wt/glmps-42/.mcp.json');
});

test('no plan without a cwd: there is nowhere to register the channel', () => {
  // Falling back to a state-dir file would silently reproduce the exact bug
  // this change fixes, so refuse instead and leave the launch unchanged.
  assert.equal(channelLaunchPlan({ job: slackJob(), stateDir: '/state', serverPath: '/s.js' }), null);
});

// Putting .mcp.json in the worktree registers the channel, but a project-scope
// MCP server is APPROVED interactively on first use, and a runner launch has
// nobody to answer that prompt: the session sits there with no transcript and
// no session id. The launch therefore pre-approves exactly this one server, in
// the worktree's own settings.local.json - narrow on purpose, since
// enableAllProjectMcpServers would bless anything a repo ever ships.

test('the plan pre-approves its own server in the worktree settings', () => {
  const plan = channelLaunchPlan({ job: slackJob(), ...opts });
  assert.equal(plan.approval.path, '/wt/glmps-42/.claude/settings.local.json');
  assert.deepEqual(plan.approval.patch, { enabledMcpjsonServers: ['scut-slack'] });
});

test('pre-approval names ONLY the scut server, never a blanket enable', () => {
  const plan = channelLaunchPlan({ job: slackJob(), ...opts });
  assert.deepEqual(plan.approval.patch.enabledMcpjsonServers, ['scut-slack']);
  assert.equal('enableAllProjectMcpServers' in plan.approval.patch, false);
});

test('mergeApproval unions with an existing settings file instead of clobbering it', () => {
  const merged = mergeApproval(
    { permissions: { allow: ['Bash'] }, enabledMcpjsonServers: ['other'] },
    { enabledMcpjsonServers: ['scut-slack'] },
  );
  assert.deepEqual(merged.enabledMcpjsonServers, ['other', 'scut-slack']);
  assert.deepEqual(merged.permissions, { allow: ['Bash'] }, 'unrelated settings survive');
});

// Claude Code 2.1.228 shows a blocking modal for --dangerously-load-
// development-channels ("WARNING: Loading development channels", confirm
// "I am using this for local development"), on EVERY session, with no
// persisted acceptance. A runner launch has nobody to click it, so attaching
// the channel by default stalled every Slack-originated job at a dialog.

test('a slack job gets NO channel plan unless the channel is explicitly enabled', () => {
  const off = { stateDir: '/state', cwd: '/wt/glmps-42', serverPath: '/s.js' };
  assert.equal(channelLaunchPlan({ job: slackJob(), ...off }), null);
  assert.equal(channelLaunchPlan({ job: slackJob(), ...off, enabled: false }), null);
  // Only an exact true opts in; a truthy string must not.
  assert.equal(channelLaunchPlan({ job: slackJob(), ...off, enabled: 'yes' }), null);
});

test('with no plan there is no dev-channels flag for a human to confirm', () => {
  const off = { stateDir: '/state', cwd: '/wt/glmps-42', serverPath: '/s.js' };
  const plan = channelLaunchPlan({ job: slackJob(), ...off });
  const cmd = appendArgs('claude "do the thing"', plan?.args);
  assert.equal(cmd.includes('--dangerously-load-development-channels'), false);
  assert.equal(cmd, 'claude "do the thing"');
});

test('enabling it restores the full channel plan', () => {
  const plan = channelLaunchPlan({ job: slackJob(), ...opts });
  assert.ok(plan);
  assert.ok(plan.args.includes('--dangerously-load-development-channels'));
});

test('mergeApproval is idempotent and tolerates a missing or malformed file', () => {
  const once = mergeApproval({ enabledMcpjsonServers: ['scut-slack'] }, { enabledMcpjsonServers: ['scut-slack'] });
  assert.deepEqual(once.enabledMcpjsonServers, ['scut-slack']);
  assert.deepEqual(mergeApproval(null, { enabledMcpjsonServers: ['scut-slack'] }).enabledMcpjsonServers, ['scut-slack']);
  assert.deepEqual(mergeApproval({ enabledMcpjsonServers: 'nonsense' }, { enabledMcpjsonServers: ['scut-slack'] }).enabledMcpjsonServers, ['scut-slack']);
});
