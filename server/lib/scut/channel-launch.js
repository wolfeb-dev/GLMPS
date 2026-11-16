// server/lib/scut/channel-launch.js
// Pure launch planning for the SCUT Slack channel. Given a backlog job, decide
// whether its launched session should own a Slack channel and, if so, exactly
// what MCP config and CLI flags that takes. Kept pure so every path, quoting and
// naming decision is testable without spawning anything.
//
// See docs/superpowers/plans/2026-08-02-scut-slack-channel.md. This is additive:
// a job with no plan launches exactly as it does today.
import { join } from 'node:path';
import { SERVER_NAME } from './channel-core.js';
import { stateDirEnv } from '../state-dir.js';

// A `server:` channel is resolved against the PERSISTED MCP config scopes
// (enterprise / user / project / local). A server handed over on the command
// line with --mcp-config is in none of them, which is why the first live
// session reported both of these in its header:
//   server:scut-slack - no MCP server configured with that name
//   server:scut-slack - server: entries need --dangerously-load-development-channels
// The MCP server itself connected fine; only the CHANNEL registration failed.
// So the server is written into the job worktree's own `.mcp.json` (project
// scope), which is per-job for free because every job gets its own worktree.
const PROJECT_CONFIG = '.mcp.json';
// `server:` channels are development channels and the CLI refuses them without
// this ("server: entries need --dangerously-load-development-channels"). It is
// the CLI's own wording, not ours.
//
// It is an ALLOWLIST that takes the entries, `<servers...>`, NOT a boolean.
// Passed bare it has no value to consume, and glmps-45 could not open
// Claude at all: "option '--dangerously-load-development-channels <servers...>'
// argument missing". Every entry enabled by --channels has to be named here too.
//
// THIS FLAG COSTS A HUMAN CLICK, WHICH IS WHY THE WHOLE PLAN IS OPT-IN.
// Claude Code 2.1.228 renders a blocking modal for it on every session:
//   title   "WARNING: Loading development channels"
//   confirm "I am using this for local development"   cancel "Exit"
// (strings read out of the shipped binary). Its gate skips the modal only when
// channels are feature-disabled, auth is not first-party, or a managed policy
// blocks channels; there is NO persisted acceptance and no environment bypass,
// so it reappears every launch. And there is no spelling that avoids it: the
// resolver rejects any `server:` entry that is not marked dev, and only
// `plugin:<name>@<marketplace>` channels are exempt from the flag. A runner
// launch has nobody to answer a modal, so a Slack-originated job simply stopped
// there (operator-reported, glmps-49).
const DEV_CHANNELS_FLAG = '--dangerously-load-development-channels';

/**
 * Which interpreter can actually run channel-server.js, and what environment
 * that takes.
 *
 * `process.execPath` alone is NOT the answer, which is what broke the first
 * live test (glmps-43): this server is started by the Antigravity IDE
 * binary running as node (ELECTRON_RUN_AS_NODE=1), so execPath is
 * "Antigravity IDE.exe". Copied bare into the MCP config, Claude Code spawned
 * the IDE instead of a node script, the child never spoke JSON-RPC, and the
 * connection closed after ~3s with no channel and no tool.
 *
 * @param {object} host
 * @param {string} host.execPath  - process.execPath of the running server
 * @param {string} [host.electron] - process.versions.electron, when hosted by Electron
 * @returns {{ command: string, env: Record<string,string> }}
 */
export function resolveInterpreter({ execPath = '', electron = undefined } = {}) {
  const base = String(execPath).replace(/\\/g, '/').split('/').pop() ?? '';
  if (/^node(\.exe)?$/i.test(base)) return { command: execPath, env: {} };
  // An Electron binary in node mode still reports process.versions.electron
  // (verified: node 22.21.1 / electron 39.2.3 under ELECTRON_RUN_AS_NODE=1), and
  // re-running it with that flag is guaranteed to work - it is the interpreter
  // already executing this code. Preferred over PATH for exactly that reason.
  if (electron) return { command: execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  // Neither: nothing here knows what this host is, so the only remaining guess
  // is a node on PATH. A wrong guess fails loudly at spawn rather than silently
  // launching whatever the host binary happens to be.
  return { command: 'node', env: {} };
}

/**
 * @param {object} opts
 * @param {object} opts.job         - backlog item (needs origin.via==='slack' + channel + thread_ts)
 * @param {string} opts.stateDir    - GLMPS state dir; the child resolves creds from it
 * @param {string} opts.serverPath  - absolute path to channel-server.js
 * @param {string} [opts.nodeBin]   - explicit interpreter override for the child
 * @param {object} [opts.host]      - {execPath, electron} of the running server, for interpreter resolution
 * @param {string} [opts.credsFile] - explicit creds file, when the server was given one
 * @param {boolean} [opts.enabled]  - opt-in switch, default OFF (see below)
 * @returns {null | { serverName, configPath, config, args }}
 */
export function channelLaunchPlan({
  job,
  stateDir,
  cwd = null,
  serverPath,
  nodeBin = null,
  host = { execPath: process.execPath, electron: process.versions.electron },
  credsFile = null,
  enabled = false,
} = {}) {
  // Opt-in, and default OFF, because the plan's own DEV_CHANNELS_FLAG (see the
  // note on it above) makes the launched session stop at a modal that nothing
  // in an unattended run can answer. Off, a Slack-originated job launches
  // exactly like any other job and the operator relay still works end to end:
  // the launch header points the session at the /devlog and /gate endpoints,
  // which SCUT already mirrors into the originating thread, and park/wake
  // carries the operator's follow-ups back in. On, the session additionally
  // owns an in-band Slack tool and someone has to click once per launch.
  // Exactly `true`: a stray truthy config value must not silently re-arm a
  // dialog that blocks the whole automation.
  if (enabled !== true) return null;
  const origin = job?.origin ?? null;
  if (!origin || origin.via !== 'slack') return null;
  // Both are load-bearing: without a channel AND a thread there is nothing to
  // bind to, and a half-configured channel would poll the wrong conversation.
  if (!origin.channel || !origin.thread_ts) return null;
  // The worktree IS the registration scope. Without one there is nowhere to
  // persist the server, and falling back to a state-dir file would silently
  // reproduce the "no MCP server configured with that name" failure above.
  if (!cwd) return null;

  // Forward slashes, always. Node accepts them for every fs call on Windows,
  // and a path with no backslashes carries nothing for a shell to eat on the
  // way to the launched CLI (see the quoting note at the bottom of this file -
  // this is the belt to that braces).
  const configPath = join(cwd, PROJECT_CONFIG).replace(/\\/g, '/');
  const interp = nodeBin ? { command: nodeBin, env: {} } : resolveInterpreter(host);
  const config = {
    mcpServers: {
      [SERVER_NAME]: {
        command: interp.command,
        args: [serverPath],
        // No token here on purpose. The child calls loadCreds() at runtime, so
        // the secret never lands in this file (which is plain JSON on disk).
        env: {
          ...interp.env,
          SCUT_CHANNEL: String(origin.channel),
          SCUT_THREAD_TS: String(origin.thread_ts),
          SCUT_AGENT_ID: String(origin.agentId || 'riker'),
          SCUT_TICKET: String(job.id ?? ''),
          ...stateDirEnv(stateDir),
          ...(credsFile ? { SCUT_CREDS_FILE: credsFile } : {}),
        },
      },
    },
  };

  return {
    serverName: SERVER_NAME,
    configPath,
    config,
    // Registering the server is not the same as being allowed to RUN it: a
    // project-scope MCP server is approved interactively on first use, and a
    // runner launch has nobody to answer that prompt (glmps-45 sat
    // with a live process, no transcript and no session id). Pre-approve this
    // one server in the worktree's own settings. Deliberately NOT
    // `enableAllProjectMcpServers`, which would bless anything a repo ever
    // ships into a checkout an agent is about to run.
    approval: {
      path: join(cwd, '.claude', 'settings.local.json').replace(/\\/g, '/'),
      patch: { enabledMcpjsonServers: [SERVER_NAME] },
    },
    // No --mcp-config: a server supplied that way is invisible to the channel
    // resolver (see the note at the top of this file). The worktree's .mcp.json
    // is what registers it, and this session only has to name and unlock it.
    args: ['--channels', `server:${SERVER_NAME}`, DEV_CHANNELS_FLAG, `server:${SERVER_NAME}`],
  };
}

// The seeded launch is a SHELL STRING typed into a terminal, not an argv array,
// so quoting here is load-bearing. Quote anything that is not a plain token.
// The first version quoted only on whitespace, and a Windows path has none, so
// C:\Users\op\... went through bare into Git Bash, which read every
// backslash as an escape and produced "C:Usersop..." - glmps-43
// could not start at all. Inside double quotes bash leaves \U alone, so quoting
// preserves the path, and cmd.exe accepts the same string.
const SAFE_TOKEN = /^[A-Za-z0-9_:=./-]+$/;
const quote = (a) => {
  const s = String(a);
  return SAFE_TOKEN.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
};

/**
 * Fold the pre-approval into whatever settings the worktree already has. The
 * file belongs to the checkout, not to us: unrelated keys survive untouched and
 * the server list is a union, so running twice changes nothing and a
 * hand-written entry is never dropped. A missing or malformed file is treated
 * as empty rather than as a reason to fail the launch.
 */
export function mergeApproval(existing, patch) {
  const base = existing && typeof existing === 'object' ? existing : {};
  const current = Array.isArray(base.enabledMcpjsonServers) ? base.enabledMcpjsonServers : [];
  const added = Array.isArray(patch?.enabledMcpjsonServers) ? patch.enabledMcpjsonServers : [];
  return { ...base, enabledMcpjsonServers: [...new Set([...current, ...added])] };
}

/** Append CLI args to a seeded command string, quoting each one. */
export function appendArgs(command, args) {
  if (!args || args.length === 0) return command;
  return `${command} ${args.map(quote).join(' ')}`;
}
