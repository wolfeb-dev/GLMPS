// server/lib/scut/channel-server.js
// The SCUT Slack channel provider: a zero-dep stdio MCP server bound to ONE
// Slack thread, launched as part of the session that owns that thread.
//
// This is the thin I/O edge. Every decision lives in channel-core.js; this file
// only moves bytes: stdin -> dispatch -> stdout, and a poll timer that turns new
// thread messages into `notifications/claude/channel` pushes.
//
// Why this exists: see docs/scut-slack-vs-discord-delivery.md. The short of it
// is that Slack follow-ups used to be delivered by guessing at a session's
// lifecycle (park poll / steer note / drop / relaunch); here they are delivered
// over the session's own MCP connection, the way the Discord plugin did it.
//
// Configuration is env, set by server/lib/scut/channel-launch.js at launch:
//   SCUT_CHANNEL          the Slack channel id
//   SCUT_THREAD_TS        the thread this session owns
//   SCUT_AGENT_ID         which persona replies (default riker)
//   SCUT_TICKET           backlog id, for logging only
//   SCUT_CHANNEL_POLL_MS  poll cadence (default 3000)
//   GLMPS_STATE_DIR          where creds + settings live
//
// The bot token is read HERE, at runtime, from the creds file the wizard wrote.
// It is deliberately never written into the generated MCP config.
import { createInterface } from 'node:readline';
import { createSlackWeb } from './slack-web.js';
import { loadCreds } from './config.js';
import { getBobMode, getAllowedUsers, getProjectSystems } from './settings.js';
import { resolveTheme } from './bobiverse.js';
import { postAs } from './provision.js';
import { dispatch, initializeResult, newMessages, channelNotification } from './channel-core.js';
import { collectAttachments } from './attachments.js';
// glmps-44: a poll failure used to end at the log() line below and
// nothing else - the operator sees a healthy live session that will never
// hear them again unless they happen to know which mcp-logs directory to
// read. This does NOT replace that log; it supplements it so the failure also
// reaches the dashboard's alert center (a different process, hence the
// on-disk handoff - see channel-health.js's header for why).
import { recordPollFailure, clearChannelHealth, channelHealthDir } from './channel-health.js';

const CHANNEL = process.env.SCUT_CHANNEL ?? '';
const THREAD_TS = process.env.SCUT_THREAD_TS ?? '';
const AGENT_ID = process.env.SCUT_AGENT_ID || 'riker';
const TICKET = process.env.SCUT_TICKET || '';
const POLL_MS = Math.max(1000, Number(process.env.SCUT_CHANNEL_POLL_MS ?? 3000) || 3000);
const HEALTH_DIR = channelHealthDir(process.env);

// stdout is the JSON-RPC wire and nothing else may touch it; all logging goes to
// stderr, which the harness captures as MCP server logs.
const log = (m) => { try { process.stderr.write(`scut-slack${TICKET ? ` [${TICKET}]` : ''}: ${m}\n`); } catch { /* stderr gone */ } };
const send = (o) => { try { process.stdout.write(JSON.stringify(o) + '\n'); } catch (e) { log(`write failed: ${e?.message ?? e}`); } };

let web = null;
let botUserId = null;
// Held from connect() so poll() can authenticate an attachment download. The
// bot token never leaves this process: it is read from the creds file at
// startup and is deliberately not written into the generated MCP config.
let botToken = null;
// Start the cursor at the thread root: everything after it is a follow-up the
// session has not seen. That includes anything the operator sent while the
// session was still booting, which the old router path used to discard.
let lastTs = THREAD_TS || null;
let polling = false;
// Tracks whether a failure MIGHT still be recorded for this channel, so a
// healthy channel (the overwhelming majority of ticks, forever) does not pay
// an unlink() syscall on every tick just to confirm nothing is there. Starts
// true, not false: this process could be a crash-restart of a channel that
// left a failure file behind, and there is no cheaper way to know that than
// one attempt - after the first successful poll clears it (or finds nothing
// to clear), later successes skip the syscall entirely until this process's
// own poll fails again.
let mayHaveFailureOnDisk = true;

function theme() {
  try { return resolveTheme(getBobMode(), { projectSystems: getProjectSystems() }); } catch { return undefined; }
}

async function connect() {
  if (!CHANNEL || !THREAD_TS) { log('no SCUT_CHANNEL/SCUT_THREAD_TS - channel inert'); return false; }
  const creds = loadCreds();
  if (!creds.botToken) { log('no bot token available - channel inert'); return false; }
  botToken = creds.botToken;
  web = createSlackWeb({ token: creds.botToken });
  try {
    const who = await web.authTest();
    botUserId = who?.user_id ?? null;
  } catch (e) {
    // Not fatal: bot_id already filters our own posts. Losing user_id only
    // costs us the belt-and-braces check.
    log(`auth.test failed (${e?.message ?? e}); continuing without a bot user id`);
  }
  return true;
}

// One poll. Never throws: a transient Slack error must cost this tick, not the
// channel. The cursor only advances over messages we actually delivered, so a
// failed tick replays rather than skips.
async function poll() {
  if (!web || polling) return;
  polling = true;
  try {
    const payload = await web.conversationsReplies({ channel: CHANNEL, ts: THREAD_TS, oldest: lastTs ?? undefined });
    // the same sender allowlist every other inbound path checks. Read per
    // poll so an allowlist edit applies at once; empty = nothing delivered.
    const { messages, lastTs: next, withheld } = newMessages(payload, { lastTs, rootTs: THREAD_TS, botUserId, allowedUsers: getAllowedUsers() });
    if (withheld) log(`withheld ${withheld} message(s) from senders not on the SCUT allowlist`);
    for (const m of messages) {
      // Slack sends file metadata, not bytes, so an attached image only reaches
      // the session if it is downloaded here first. A failure costs the
      // attachment, never the message: the text is delivered either way, and
      // collectAttachments already writes the reason into the block it returns.
      let attachments = [];
      try {
        ({ files: attachments } = await collectAttachments(m, {
          channel: CHANNEL, ts: m.ts, token: botToken, env: process.env,
        }));
      } catch (e) {
        log(`attachment fetch failed for ${m.ts} (${e?.message ?? e})`);
      }
      send(channelNotification(m, { channel: CHANNEL, thread_ts: THREAD_TS, attachments }));
    }
    if (messages.length) log(`delivered ${messages.length} message(s) into the session`);
    lastTs = next;
    // The alert must not outlive the problem, but a channel that has never
    // failed (this process's whole life) should not pay an unlink() every
    // tick forever just to confirm nothing is there.
    if (mayHaveFailureOnDisk) clearChannelHealth(HEALTH_DIR, { channel: CHANNEL });
    mayHaveFailureOnDisk = false;
  } catch (e) {
    log(`poll failed (${e?.message ?? e})`);
    recordPollFailure(HEALTH_DIR, { channel: CHANNEL, threadTs: THREAD_TS, ticket: TICKET || null }, e);
    mayHaveFailureOnDisk = true;
  } finally {
    polling = false;
  }
}

async function reply(args) {
  const text = String(args?.message ?? '').trim();
  if (!text) throw new Error('message is required');
  if (!web) throw new Error('slack channel is inert (no credentials)');
  await postAs(web, AGENT_ID, { channel: CHANNEL, thread_ts: THREAD_TS, text }, theme());
  return 'posted to the Slack thread';
}

const handlers = {
  initialize: (params) => initializeResult(params, { agentId: AGENT_ID }),
  callTool: async (name, args) => {
    if (name !== 'reply') throw new Error(`unknown tool: ${name}`);
    return reply(args);
  },
};

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return log('ignored a non-JSON line'); }
  try {
    const res = await dispatch(msg, handlers);
    if (res) send(res);
  } catch (e) {
    log(`dispatch threw (${e?.message ?? e})`);
  }
});

// The harness owns this process's lifetime; when it closes stdin we are done.
process.stdin.on('end', () => process.exit(0));
process.on('uncaughtException', (e) => log(`uncaught: ${e?.message ?? e}`));
process.on('unhandledRejection', (e) => log(`unhandled rejection: ${e?.message ?? e}`));

connect().then((ok) => {
  if (!ok) return;                       // still serves tools/list; just never polls
  log(`bound to ${CHANNEL} thread ${THREAD_TS}, polling every ${POLL_MS}ms`);
  const timer = setInterval(() => { void poll(); }, POLL_MS);
  timer.unref?.();
  void poll();
}).catch((e) => log(`startup failed (${e?.message ?? e})`));
