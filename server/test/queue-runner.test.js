import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as qr from '../lib/orchestration/queue-runner.js';
import { resolveRoute } from '../lib/orchestration/queue-runner.js';

test('pickNextJob returns lowest-order queued item', () => {
  const items = [
    { id: 'a', state: 'queued', order: 5 },
    { id: 'b', state: 'in_progress', order: 1 },
    { id: 'c', state: 'queued', order: 2 },
  ];
  assert.equal(qr.pickNextJob(items).id, 'c');
  assert.equal(qr.pickNextJob([{ id: 'x', state: 'done', order: 0 }]), null);
});

test('pickNextJob skips a card that still holds a ledger entry (double-launch guard)', () => {
  const items = [
    { id: 'a', state: 'queued', order: 1 },
    { id: 'b', state: 'queued', order: 2 },
  ];
  assert.equal(qr.pickNextJob(items, ['a']).id, 'b');
  assert.equal(qr.pickNextJob(items, ['a', 'b']), null);
});

test('pickNextJob is unchanged when no ledger is supplied', () => {
  const items = [{ id: 'a', state: 'queued', order: 1 }];
  assert.equal(qr.pickNextJob(items).id, 'a');
});

test('launchHeader: base header names the card and the close instruction', () => {
  const h = qr.launchHeader({ job: { id: 'glmps-7', project: 'nq' }, port: 8123 });
  assert.match(h, /Backlog card glmps-7 \(project: nq\)/);
  assert.match(h, /PATCH http:\/\/127\.0\.0\.1:8123\/api\/backlog\/glmps-7/);
  assert.match(h, /Your task follows\./);
  // No chat origin -> no handoff line.
  assert.doesNotMatch(h, /Discord/i);
});

test('launchHeader: a legacy discord-origin ticket gets NO chat handoff (Discord retired 2026-08-29)', () => {
  const h = qr.launchHeader({
    job: { id: 'glmps-8', project: 'nq', origin: { via: 'discord', chatId: 'C123', messageId: 'M456' } },
    port: 8123,
  });
  // The branch is gone, so a legacy row degrades to an ordinary card: still a
  // well-formed header, but no reply instruction naming a tool that no longer
  // exists, and no chat-altitude budget.
  assert.match(h, /Backlog card glmps-8 \(project: nq\)/);
  assert.doesNotMatch(h, /Discord/i);
  assert.doesNotMatch(h, /OWN the reply/i);
  assert.doesNotMatch(h, /state change/i);
});

test('launchHeader: a slack-origin ticket tells the launched session it OWNS the thread reply', () => {
  const h = qr.launchHeader({
    job: { id: 'glmps-10', project: 'nq', origin: { via: 'slack', channel: 'C1', thread_ts: '111.1' } },
    port: 8123,
  });
  assert.match(h, /slack/i);
  assert.match(h, /C1/);
  assert.match(h, /111\.1/);
  assert.match(h, /will NOT reply inline/i);
});

test('launchHeader: a slack-origin ticket must say what it is waiting on before going quiet (glmps-2-0-211)', () => {
  const h = qr.launchHeader({
    job: { id: 'glmps-12', project: 'nq', origin: { via: 'slack', channel: 'C1', thread_ts: '111.1' } },
    port: 8123,
  });
  assert.match(h, /WAITING STATE/);
  assert.match(h, /waiting on/i);
  assert.match(h, /next step/i);
  assert.match(h, /expected time/i);
  assert.match(h, /Last step before close:/);
  const plain = qr.launchHeader({ job: { id: 'glmps-13', project: 'nq' }, port: 8123 });
  assert.doesNotMatch(plain, /WAITING STATE/);
});

test('launchHeader: slack origin without channel/thread_ts adds no handoff line (incomplete origin)', () => {
  const h = qr.launchHeader({ job: { id: 'glmps-11', project: 'nq', origin: { via: 'slack' } }, port: 8123 });
  assert.doesNotMatch(h, /OWN the reply/i);
});

test('launchHeader names the routed agent', () => {
  const h = qr.launchHeader({
    job: { id: 'x-1', project: 'p' }, port: 8123,
    route: { agent: 'ui-designer', taskClass: 'ui', confidence: 0.8, via: 'classified' },
  });
  assert.match(h, /ROUTING/);
  assert.match(h, /ui-designer/);
  assert.match(h, /"Routing note:"/);
});

test('launchHeader is unchanged when nothing routes', () => {
  const job = { id: 'x-1', project: 'p' };
  assert.equal(qr.launchHeader({ job, port: 8123, route: { agent: null } }), qr.launchHeader({ job, port: 8123 }));
});

test('pickNextJob skips quarantined items (poison gate)', () => {
  const items = [
    { id: 'q', state: 'queued', order: 1, quarantined: true },
    { id: 'ok', state: 'queued', order: 2 },
  ];
  assert.equal(qr.pickNextJob(items).id, 'ok', 'quarantined job is not auto-launched');
  assert.equal(qr.pickNextJob([{ id: 'q', state: 'queued', order: 1, quarantined: true }]), null);
});

// glmps-2-0-66: the operator's session cap is for card work; merge-queue
// reviewers run beside it.
test('slotsUsed counts card sessions only, never merge-queue reviewers', () => {
  assert.equal(qr.slotsUsed({}), 0);
  assert.equal(qr.slotsUsed({ 'glmps-1': { pid: 1 }, 'glmps-1-review-r1': { role: 'reviewer' }, 'glmps-2': {} }), 2);
  assert.equal(qr.slotsUsed({ 'glmps-1': {} }, { except: 'glmps-1' }), 0);
  assert.equal(qr.slotsUsed(null), 0);
});

test('shouldClaim respects enabled, paused, and concurrency', () => {
  assert.equal(qr.shouldClaim({ enabled: true, paused: false, runningCount: 0, maxConcurrent: 1 }), true);
  assert.equal(qr.shouldClaim({ enabled: false, paused: false, runningCount: 0, maxConcurrent: 1 }), false);
  assert.equal(qr.shouldClaim({ enabled: true, paused: true, runningCount: 0, maxConcurrent: 1 }), false);
  assert.equal(qr.shouldClaim({ enabled: true, paused: false, runningCount: 1, maxConcurrent: 1 }), false);
});

test('reconcile drops finished jobs, requeues dead ones, holds past maxRetries', () => {
  const items = [
    { id: 'done1', state: 'done' },
    { id: 'dead1', state: 'in_progress' },
    { id: 'dead2', state: 'in_progress' },
  ];
  const ledger = {
    done1: { pid: 1, startedAt: 0, target: 'cursor', retries: 0 },
    dead1: { pid: 2, startedAt: 0, target: 'cursor', retries: 0 },
    dead2: { pid: 3, startedAt: 0, target: 'cursor', retries: 2 },
  };
  const isAlive = (pid) => false;
  const out = qr.reconcileLedger({ ledger, items, isAlive, now: 10, maxRuntimeMs: 1000, maxRetries: 2 });
  assert.equal(out.ledger.done1, undefined);
  assert.equal(out.ledger.dead1.retries, 1);
  assert.equal(out.ledger.dead2, undefined);
  assert.deepEqual(out.actions.find(a => a.id === 'dead1'), { id: 'dead1', action: 'requeue', reason: 'process exited' });
  assert.equal(out.actions.find(a => a.id === 'dead2').action, 'hold');
});

test('reconcile treats archived as finished: dropped from ledger, no requeue/hold', () => {
  // A ticket can be archived via PATCH while its runner-ledger entry is still
  // live. Without 'archived' in FINISHED, a dead/overrun archived job gets
  // requeued (un-archiving it) or silently eats a maxConcurrent slot forever.
  const items = [{ id: 'arch1', state: 'archived' }];
  const ledger = { arch1: { pid: 1, startedAt: 0, target: 'cursor', retries: 0 } };
  const out = qr.reconcileLedger({ ledger, items, isAlive: () => false, now: 10, maxRuntimeMs: 1000, maxRetries: 2 });
  assert.equal(out.ledger.arch1, undefined, 'archived entry dropped from next ledger');
  assert.equal(out.actions.find(a => a.id === 'arch1'), undefined, 'no requeue/hold action for an archived ticket');
});

test('reconcile does NOT drop live jobs when the backlog reads back empty', () => {
  // glmps-42: `backlogStore.load` swallows a parse error and returns
  // no items, and a torn read is reachable - several sessions write backlog.json
  // (every devlog POST rewrites it) while the runner tick reads it. Dropping an
  // entry here is not a bookkeeping detail: the caller reclaims the worktree of
  // anything that left the ledger, so one unlucky read DELETES a live agent's
  // checkout out from under it. An empty items list means "unreadable", never
  // "every job finished".
  const ledger = { j1: { pid: null, startedAt: 0, target: 'antigravity', retries: 0 } };
  const out = qr.reconcileLedger({ ledger, items: [], isAlive: () => false, now: 10, maxRuntimeMs: 1000, maxRetries: 2 });
  assert.ok(out.ledger.j1, 'entry retained when the backlog yielded nothing');
  assert.deepEqual(out.actions, []);
});

test('reconcile keeps an entry whose card is simply absent, rather than silently dropping it', () => {
  // A non-empty backlog that just does not mention this id. Same hazard, smaller
  // blast radius: keep the lease and let maxRuntimeMs be the thing that ends the
  // job, so the decision to reclaim is always one an action explains.
  const items = [{ id: 'other', state: 'in_progress' }];
  const ledger = { gone: { pid: null, startedAt: 0, target: 'antigravity', retries: 0 } };
  const out = qr.reconcileLedger({ ledger, items, isAlive: () => false, now: 10, maxRuntimeMs: 1000, maxRetries: 2 });
  assert.ok(out.ledger.gone, 'entry retained');
  assert.deepEqual(out.actions, []);
});

test('an absent card still times out, so a retained entry cannot leak a slot forever', () => {
  const items = [{ id: 'other', state: 'in_progress' }];
  const ledger = { gone: { pid: null, startedAt: 0, target: 'antigravity', retries: 2 } };
  const out = qr.reconcileLedger({ ledger, items, isAlive: () => false, now: 5000, maxRuntimeMs: 1000, maxRetries: 2 });
  assert.equal(out.actions[0].action, 'hold');
  assert.equal(out.ledger.gone, undefined);
});

test('an explicitly finished card is still dropped without an action', () => {
  // The guard above must not resurrect the real "this job is done" path.
  const items = [{ id: 'j1', state: 'done' }];
  const ledger = { j1: { pid: null, startedAt: 0, target: 'antigravity', retries: 0 } };
  const out = qr.reconcileLedger({ ledger, items, isAlive: () => false, now: 10, maxRuntimeMs: 1000, maxRetries: 2 });
  assert.equal(out.ledger.j1, undefined);
  assert.deepEqual(out.actions, []);
});

test('reconcile keeps an editor-launched job (pid null) alive until done or timeout', () => {
  // Editor/companion launches own their own process, so launchSession records a
  // null pid ("liveness tracked via card state + timeout"). A null pid must NOT be
  // read as "exited" - otherwise a still-running session is requeued every tick.
  const items = [{ id: 'editor1', state: 'in_progress' }];
  const ledger = { editor1: { pid: null, startedAt: 0, target: 'antigravity', retries: 0 } };
  const out = qr.reconcileLedger({ ledger, items, isAlive: () => false, now: 500, maxRuntimeMs: 1000, maxRetries: 2 });
  assert.deepEqual(out.actions, [], 'no requeue/hold while within the runtime budget');
  assert.ok(out.ledger.editor1, 'entry retained');
  assert.equal(out.ledger.editor1.retries, 0, 'no retry burned');
});

test('reconcile still times out a stuck editor-launched job (pid null) past maxRuntimeMs', () => {
  const items = [{ id: 'editor1', state: 'in_progress' }];
  const ledger = { editor1: { pid: null, startedAt: 0, target: 'antigravity', retries: 0 } };
  const out = qr.reconcileLedger({ ledger, items, isAlive: () => false, now: 5000, maxRuntimeMs: 1000, maxRetries: 2 });
  assert.equal(out.actions[0].action, 'requeue');
  assert.match(out.actions[0].reason, /timeout/);
});

test('reconcile holds/requeues a live-but-overrunning job', () => {
  const items = [{ id: 'slow', state: 'in_progress' }];
  const ledger = { slow: { pid: 9, startedAt: 0, target: 'cursor', retries: 0 } };
  const out = qr.reconcileLedger({ ledger, items, isAlive: () => true, now: 5000, maxRuntimeMs: 1000, maxRetries: 2 });
  assert.equal(out.actions[0].action, 'requeue');
  assert.match(out.actions[0].reason, /timeout/);
});


test('shouldIsolate: worktrees engage when forced on OR when concurrency > 1', () => {
  // The default (single lane, no force) keeps the agent in the repo itself.
  assert.equal(qr.shouldIsolate({ useWorktrees: false, maxConcurrent: 1 }), false);
  // Raising concurrency auto-engages isolation - the safety net for same-project jobs.
  assert.equal(qr.shouldIsolate({ useWorktrees: false, maxConcurrent: 2 }), true);
  // Forcing it on isolates even a single lane.
  assert.equal(qr.shouldIsolate({ useWorktrees: true, maxConcurrent: 1 }), true);
  assert.equal(qr.shouldIsolate({}), false);
});

test('worktreePlan: deterministic dir + valid branch, both sanitized', () => {
  const a = qr.worktreePlan({ baseDir: '/wt', project: 'data-pipeline', jobId: 'glmps-1' });
  assert.equal(a.dir, path.join('/wt', 'data-pipeline', 'glmps-1'));
  assert.equal(a.branch, 'glmps-runner/data-pipeline/glmps-1');
  // Same inputs -> same plan (collision-free per job, stable across ticks).
  assert.deepEqual(qr.worktreePlan({ baseDir: '/wt', project: 'data-pipeline', jobId: 'glmps-1' }), a);
  // Spaces / unsafe chars are scrubbed so the path is clean and the branch is git-legal.
  const b = qr.worktreePlan({ baseDir: '/wt', project: 'My Web App', jobId: 'glmps-2' });
  assert.equal(b.dir, path.join('/wt', 'My-Web-App', 'glmps-2'));
  assert.equal(b.branch, 'glmps-runner/My-Web-App/glmps-2');
  assert.ok(!/[ ~^:?*\[\\]/.test(b.branch), 'branch contains no git-illegal characters');
});

test('worktree git recipes target the repo with -C and never use a shell', () => {
  const add = qr.worktreeAddRecipe({ repo: '/repo', dir: '/wt/p/j', branch: 'glmps-runner/p/j' });
  assert.deepEqual(add, { file: 'git', args: ['-C', '/repo', 'worktree', 'add', '-B', 'glmps-runner/p/j', '/wt/p/j'] });
  assert.deepEqual(qr.worktreeRemoveRecipe({ repo: '/repo', dir: '/wt/p/j' }),
    { file: 'git', args: ['-C', '/repo', 'worktree', 'remove', '--force', '/wt/p/j'] });
  assert.deepEqual(qr.worktreePruneRecipe({ repo: '/repo' }),
    { file: 'git', args: ['-C', '/repo', 'worktree', 'prune'] });
});

test('worktreeAddRecipe branches from an explicit start point when given one (glmps-2-0-41)', () => {
  assert.deepEqual(qr.worktreeAddRecipe({ repo: '/repo', dir: '/wt/p/j', branch: 'glmps-runner/p/j', startPoint: 'origin/main' }),
    { file: 'git', args: ['-C', '/repo', 'worktree', 'add', '-B', 'glmps-runner/p/j', '/wt/p/j', 'origin/main'] });
  // No start point keeps the old HEAD-based form, which is the fallback when the fetch fails.
  assert.deepEqual(qr.worktreeAddRecipe({ repo: '/repo', dir: '/wt/p/j', branch: 'glmps-runner/p/j', startPoint: null }).args.length, 7);
  assert.deepEqual(qr.worktreeFetchRecipe({ repo: '/repo' }),
    { file: 'git', args: ['-C', '/repo', 'fetch', '-q', 'origin'] });
  assert.deepEqual(qr.upstreamRefRecipe({ repo: '/repo' }),
    { file: 'git', args: ['-C', '/repo', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'] });
});

test('launchHeader: a slack job gets the park protocol and is told NOT to close the card', () => {
  const h = qr.launchHeader({ job: { id: 'mc-9', project: 'glmps', origin: { via: 'slack', channel: 'C1', thread_ts: '1.1' } }, port: 8123 });
  assert.match(h, /api\/scut\/park/);
  assert.match(h, /do NOT close the card/);
  assert.match(h, /"action":"wake"/);
  const plain = qr.launchHeader({ job: { id: 'mc-9', project: 'glmps' }, port: 8123 });
  assert.doesNotMatch(plain, /api\/scut\/park/, 'non-slack jobs keep the old close-the-card contract');
});

test('launchHeader: a slack job is told what to do on a handoff reply (stop, post nothing, end the turn)', () => {
  const h = qr.launchHeader({ job: { id: 'mc-47', project: 'glmps', origin: { via: 'slack', channel: 'C1', thread_ts: '1.1' } }, port: 8123 });
  assert.match(h, /"action":"handoff"/);
  assert.match(h, /operator's reply will arrive as your next user message/);
  assert.match(h, /post nothing further/);
  assert.match(h, /end your turn/);
  assert.match(h, /provenance/, 'the wake reply field is named so the session knows it exists');
  const plain = qr.launchHeader({ job: { id: 'mc-47', project: 'glmps' }, port: 8123 });
  assert.doesNotMatch(plain, /handoff/, 'non-slack jobs never see the park protocol');
});

// The server holds a /api/scut/park poll open for `parkHoldMs` (server.js).
// The poll runs in the FOREGROUND with the Bash timeout at its 600000 ms cap,
// because only a foreground Bash call's PostToolUse can carry classifierContext
// for the reply. So the hold must stay under the cap (default 540s), the header
// must source it from a parameter, and curl --max-time must sit above the hold.

test('launchHeader: park loop states the server hold, says to poll in the foreground with Bash timeout 600000, and gives curl a max-time above the hold', () => {
  const h = qr.launchHeader({
    job: { id: 'mc-40', project: 'glmps', origin: { via: 'slack', channel: 'C1', thread_ts: '1.1' } },
    port: 8123,
    parkHoldMs: 540_000,
  });
  assert.match(h, /540s/);
  assert.doesNotMatch(h, /10-minute/);
  assert.match(h, /FOREGROUND/);
  assert.match(h, /Bash tool timeout set to 600000/);
  assert.match(h, /never in the background/);
  assert.doesNotMatch(h, /run_in_background: true/);
  const m = h.match(/--max-time (\d+)/);
  assert.ok(m, 'header names an explicit curl --max-time');
  assert.equal(Number(m[1]), 580);
  assert.ok(Number(m[1]) > 540 && Number(m[1]) < 600, 'above the hold, below the Bash cap');
});

test('launchHeader: parkHoldMs defaults to the same 540s the server currently holds, so a caller that omits it stays correct', () => {
  const h = qr.launchHeader({
    job: { id: 'mc-41', project: 'glmps', origin: { via: 'slack', channel: 'C1', thread_ts: '1.1' } },
    port: 8123,
  });
  assert.match(h, /540s/);
});

test('launchHeader: a non-default parkHoldMs is reflected verbatim, proving the header is sourced from the parameter and not a hardcoded literal', () => {
  const h = qr.launchHeader({
    job: { id: 'mc-42', project: 'glmps', origin: { via: 'slack', channel: 'C1', thread_ts: '1.1' } },
    port: 8123,
    parkHoldMs: 300_000,
  });
  assert.match(h, /300s/);
  assert.doesNotMatch(h, /540s/);
});

test('launchHeader points a slack-origin session at the relayed endpoints, not an imaginary slack tool', () => {
  const h = qr.launchHeader({ job: { id: 'glmps-9', origin: { via: 'slack', channel: 'C1', thread_ts: '111.1' } }, port: 8123 });
  assert.match(h, /C1/);
  assert.match(h, /111\.1/);
  assert.match(h, /devlog/, 'names the endpoint the agent actually has');
  // The old text promised "reply into Slack channel X", which no session can do:
  // there is no Slack tool and no scut endpoint. That produced silent threads.
  assert.doesNotMatch(h, /reply into Slack/i);
  assert.match(h, /do not|must not/i, 'tells the agent not to hunt for a credential');
});


test('shouldReclaimWorktree refuses to reclaim a checkout whose agent is still alive', () => {
  const entry = { pid: 4242, worktree: { repo: '/repo', dir: '/wt/p/j' } };
  // `held` after maxRetries is the COMMON exit, and it happens precisely
  // because the agent outran maxRuntimeMs, i.e. it is still working in there.
  assert.equal(qr.shouldReclaimWorktree({ entry, isAlive: (pid) => pid === 4242 }), false);
});

test('shouldReclaimWorktree reclaims once the pid is gone', () => {
  const entry = { pid: 4242, worktree: { repo: '/repo', dir: '/wt/p/j' } };
  assert.equal(qr.shouldReclaimWorktree({ entry, isAlive: () => false }), true);
});

test('shouldReclaimWorktree refuses a null-pid entry when no occupancy answer was given', () => {
  // Editor/companion targets always record pid null, so the pid says nothing
  // and occupancy is the only evidence. This test used to assert `true` on the
  // pre-mc-53 rationale that the caller's non-forcing removal is the safety net
  // (git refuses on a dirty tree). The mc-53 plan calls that backwards: it
  // spares the agent that committed nothing and destroys the checkout of the
  // agent that committed as it went, which is what happened to mc-59.
  const entry = { pid: null, worktree: { repo: '/repo', dir: '/wt/p/j' } };
  assert.equal(qr.shouldReclaimWorktree({ entry, isAlive: () => true }), false);
  // Given a real answer that nobody is there, it reclaims as before.
  assert.equal(qr.shouldReclaimWorktree({ entry, isAlive: () => true, liveDirs: [] }), true);
});

test('shouldReclaimWorktree is a no-op when there is no worktree', () => {
  assert.equal(qr.shouldReclaimWorktree({ entry: { pid: 1, worktree: null }, isAlive: () => false }), false);
  assert.equal(qr.shouldReclaimWorktree({ entry: {}, isAlive: () => false }), false);
  assert.equal(qr.shouldReclaimWorktree({}), false);
  assert.equal(qr.shouldReclaimWorktree({ entry: { worktree: { repo: '/r' } } }), false); // no dir
});


test('shouldReclaimWorktree refuses a checkout a live session is sitting in (glmps-53)', () => {
  const entry = { pid: null, worktree: { repo: '/repo', dir: '/wt/glmps/mc-59' } };
  assert.equal(qr.shouldReclaimWorktree({
    entry, isAlive: () => false, liveDirs: ['/wt/glmps/mc-59'],
  }), false);
});

test('shouldReclaimWorktree refuses when a live session cwd is NESTED in the checkout', () => {
  const entry = { pid: null, worktree: { repo: '/repo', dir: '/wt/p/j' } };
  assert.equal(qr.shouldReclaimWorktree({ entry, isAlive: () => false, liveDirs: ['/wt/p/j/server'] }), false);
});

test('shouldReclaimWorktree still reclaims when the live sessions are elsewhere', () => {
  const entry = { pid: null, worktree: { repo: '/repo', dir: '/wt/p/j' } };
  assert.equal(qr.shouldReclaimWorktree({ entry, isAlive: () => false, liveDirs: ['/wt/p/other', '/repo'] }), true);
});

test('shouldReclaimWorktree: a sibling directory with a shared prefix does not protect', () => {
  const entry = { pid: null, worktree: { repo: '/repo', dir: '/wt/p/j' } };
  assert.equal(qr.shouldReclaimWorktree({ entry, isAlive: () => false, liveDirs: ['/wt/p/j2'] }), true);
});

test('reclaimVerdict names the reason for every outcome', () => {
  const wt = { repo: '/repo', dir: '/wt/p/j' };
  assert.deepEqual(qr.reclaimVerdict({ entry: {}, isAlive: () => false }),
    { reclaim: false, reason: 'no-worktree' });
  assert.deepEqual(qr.reclaimVerdict({ entry: { pid: 42, worktree: wt }, isAlive: (p) => p === 42 }),
    { reclaim: false, reason: 'pid-alive' });
  assert.deepEqual(qr.reclaimVerdict({ entry: { pid: null, worktree: wt }, isAlive: () => false, liveDirs: ['/wt/p/j'] }),
    { reclaim: false, reason: 'occupied' });
  assert.deepEqual(qr.reclaimVerdict({ entry: { pid: null, worktree: wt }, isAlive: () => false, liveDirs: [] }),
    { reclaim: true, reason: 'reclaimable' });
});

test('reclaimVerdict refuses to reclaim when the occupancy signal is missing', () => {
  const wt = { repo: '/repo', dir: '/wt/p/j' };
  // The mc-53 constraint, verbatim from its plan: "A missing or throwing
  // occupancy signal must never turn into a removal." `pid: null` is every
  // editor/companion launch, so the occupancy list is the ONLY evidence there
  // is, and absent, it proves nothing.
  for (const liveDirs of [null, undefined, 'nope', 42, {}]) {
    const v = qr.reclaimVerdict({ entry: { pid: null, worktree: wt }, isAlive: () => false, liveDirs });
    assert.equal(v.reclaim, false, `liveDirs=${JSON.stringify(liveDirs) ?? 'undefined'} must not reclaim`);
    assert.equal(v.reason, 'occupancy-unknown');
  }
});

test('reclaimVerdict still reclaims when a real occupancy list proves nobody is there', () => {
  const wt = { repo: '/repo', dir: '/wt/p/j' };
  // An explicit array, including an empty one, is a real answer: the caller
  // looked, and this is who is live. Junk ENTRIES inside a real array are still
  // a real answer, so they must not block the reclaim either, or checkouts leak.
  assert.deepEqual(qr.reclaimVerdict({ entry: { pid: null, worktree: wt }, isAlive: () => false, liveDirs: [] }),
    { reclaim: true, reason: 'reclaimable' });
  assert.equal(qr.reclaimVerdict({ entry: { pid: null, worktree: wt }, isAlive: () => false, liveDirs: [null, undefined, ''] }).reclaim, true);
});


test('pickNextJob skips blocked tickets; blockedQueued lists them', () => {
  const items = [
    { id: 'glmps-1', state: 'done', order: 1 },
    { id: 'glmps-2', state: 'queued', order: 2, blockedBy: ['glmps-1'] },          // resolved -> launchable
    { id: 'glmps-3', state: 'queued', order: 3, blockedBy: ['glmps-4'] },          // blocked
    { id: 'glmps-4', state: 'in_progress', order: 4 },
    { id: 'glmps-5', state: 'queued', order: 5, blockedBy: ['glmps-999'] },        // dangling -> not blocking
  ];
  assert.equal(qr.pickNextJob(items).id, 'glmps-2');
  assert.deepEqual(qr.blockedQueued(items), [{ id: 'glmps-3', blockers: ['glmps-4'], forBlockers: true }]);
});

test('unresolvedBlockers: done/archived resolve a blocker, missing ids do not block', () => {
  const byId = new Map([
    ['done1', { id: 'done1', state: 'done' }],
    ['arch1', { id: 'arch1', state: 'archived' }],
    ['open1', { id: 'open1', state: 'in_progress' }],
  ]);
  assert.deepEqual(qr.unresolvedBlockers({ blockedBy: ['done1', 'arch1'] }, byId), []);
  assert.deepEqual(qr.unresolvedBlockers({ blockedBy: ['open1'] }, byId), ['open1']);
  assert.deepEqual(qr.unresolvedBlockers({ blockedBy: ['missing1'] }, byId), []);
  assert.deepEqual(qr.unresolvedBlockers({}, byId), []);
});

test('buildSeedDoc renders structured sections and working agreement', () => {
  const doc = qr.buildSeedDoc({
    id: 'glmps-9', title: 'T', project: 'p', prompt: 'raw prompt',
    description: 'why text',
    acceptanceCriteria: [{ text: 'first', done: false }, { text: 'second', done: true }],
    relevantFiles: ['web/a.js'], deferredRefs: ['glmps-2'],
  }, { port: 8123 });
  assert.match(doc, /## Why \/ Context\n+why text/);
  assert.match(doc, /AC-1: first/);
  assert.match(doc, /AC-2: second \(already done\)/);
  assert.match(doc, /web\/a\.js/);
  assert.match(doc, /glmps-2/);
  assert.match(doc, /## Task\n+raw prompt/);
  assert.match(doc, /devlog/);
  assert.match(doc, /gate/);
  assert.match(doc, /PASS\|CONCERNS\|FAIL\|WAIVED/);
  // mc-15 + loop completion: the working agreement describes the real gate-less
  // surface (board flag) AND the now-real learning-loop feed (a gate-less close
  // emits a ticket-closed-without-gate gap - see backlog-gateless-gap.test.js).
  assert.match(doc, /gate-less close/);
  assert.match(doc, /learning loop/);
});

// glmps-2-0-66: the queue merged 1 of 24 PRs in its first 2 days because the
// seed never told agents it existed, so they asked the operator to merge.
test('buildSeedDoc sends a finished PR to the merge queue, never to the operator', () => {
  const doc = qr.buildSeedDoc({ id: 'glmps-9', title: 'T', prompt: 'p' }, { port: 8123 });
  assert.match(doc, /POST http:\/\/127\.0\.0\.1:8123\/api\/backlog\/glmps-9\/merge-request \{"prUrl":/);
  assert.match(doc, /never run `gh pr merge`/i);
  assert.match(doc, /never ask the operator to merge/i);
});

test('buildSeedDoc tells the agent to run only the tests its change touches (glmps-2-0-runtime-98)', () => {
  const doc = qr.buildSeedDoc({ id: 'glmps-9', title: 'T', prompt: 'p' }, { port: 8123 });
  assert.match(doc, /Run only the tests your change touches: node scripts\/affected-tests\.mjs/);
  assert.match(doc, /Never run the full suite/);
});

test('buildSeedDoc degrades to prompt-only for legacy tickets', () => {
  const doc = qr.buildSeedDoc({ id: 'glmps-8', title: 'T', prompt: 'just a prompt' }, { port: 8123 });
  assert.match(doc, /## Task\n+just a prompt/);
  assert.doesNotMatch(doc, /## Why \/ Context/);
  assert.match(doc, /## Working agreement/); // agreement always present
});


test('renderSpec: absent/empty spec renders nothing', () => {
  assert.deepEqual(qr.renderSpec(undefined), []);
  assert.deepEqual(qr.renderSpec(null), []);
  assert.deepEqual(qr.renderSpec({}), []);
  // profile alone with no other worker content is still "nothing to say"
  assert.deepEqual(qr.renderSpec({ profile: 'worker' }), []);
});

test('renderSpec: worker profile, full spec renders deliverable/mode/risk/escalation + progress-audit', () => {
  const lines = qr.renderSpec({
    act: 'assess', riskTier: 'high', escalation: 'the fix touches live trading files',
    deliverable: 'a written diagnosis, no code changes', profile: 'worker',
  });
  assert.equal(lines.some(l => /^Deliverable: a written diagnosis, no code changes$/.test(l)), true);
  assert.equal(lines.some(l => /assess only.*report, do not change code/i.test(l)), true);
  assert.equal(lines.some(l => /^Risk tier: high/.test(l)), true);
  assert.equal(lines.some(l => /^Escalate \(stop and ask on the card\) when: the fix touches live trading files$/.test(l)), true);
  assert.equal(lines.some(l => /audit your claims against actual command\/test output/i.test(l)), true);
});

test('renderSpec: worker profile is the default when profile is absent', () => {
  const lines = qr.renderSpec({ deliverable: 'ship it' });
  assert.equal(lines[0], 'Deliverable: ship it');
  assert.equal(lines.some(l => /CRITIC/.test(l)), false);
});

test('renderSpec: worker partial spec only renders present fields, plus progress-audit', () => {
  const lines = qr.renderSpec({ escalation: 'tests start failing' });
  assert.deepEqual(lines, [
    'Escalate (stop and ask on the card) when: tests start failing',
    'Before reporting done, audit your claims against actual command/test output.',
  ]);
  assert.equal(lines.some(l => l.startsWith('Deliverable:')), false);
  assert.equal(lines.some(l => l.startsWith('Mode:')), false);
});

test('renderSpec: assess mode alone renders the assess line + progress-audit', () => {
  const lines = qr.renderSpec({ act: 'assess' });
  assert.equal(lines.some(l => /Mode: assess only/.test(l)), true);
  assert.equal(lines.length, 2);
});

test('renderSpec: critic profile renders a review contract, not the worker lines', () => {
  const lines = qr.renderSpec({ profile: 'critic', riskTier: 'medium', escalation: 'the verdict is ambiguous' });
  assert.equal(lines.some(l => /CRITIC/.test(l)), true);
  assert.equal(lines.some(l => /do not modify files/i.test(l)), true);
  assert.equal(lines.some(l => /findings/i.test(l) && /severity/i.test(l)), true);
  assert.equal(lines.some(l => /verdict/i.test(l)), true);
  assert.equal(lines.some(l => /^Risk tier: medium/.test(l)), true);
  assert.equal(lines.some(l => /^Escalate \(stop and ask on the card\) when: the verdict is ambiguous$/.test(l)), true);
  // Critic contract never includes the worker-only progress-audit clause.
  assert.equal(lines.some(l => /audit your claims/i.test(l)), false);
});

test('renderSpec: critic profile alone (no risk/escalation) still renders the review contract', () => {
  const lines = qr.renderSpec({ profile: 'critic' });
  assert.ok(lines.length >= 2);
  assert.equal(lines.some(l => /CRITIC/.test(l)), true);
});


test('renderSpec: verify profile renders execution-first, critic-second instructions, not the worker/critic lines', () => {
  const lines = qr.renderSpec({ profile: 'verify', riskTier: 'high', escalation: 'the change touches prod' });
  assert.equal(lines.some(l => /LAYERED VERIFICATION/.test(l)), true);
  assert.equal(lines.some(l => /execution checks.*FIRST/i.test(l)), true);
  assert.equal(lines.some(l => /hard veto/i.test(l) && /lens "exec"/.test(l)), true);
  assert.equal(lines.some(l => /independent cross-model critic/i.test(l)), true);
  assert.equal(lines.some(l => /^Risk tier: high/.test(l)), true);
  assert.equal(lines.some(l => /^Escalate \(stop and ask on the card\) when: the change touches prod$/.test(l)), true);
  // Neither the worker's progress-audit line nor the critic's own contract text renders.
  assert.equal(lines.some(l => /audit your claims/i.test(l)), false);
  assert.equal(lines.some(l => /^You are the CRITIC/.test(l)), false);
});

test('renderSpec: verify profile alone (no risk/escalation) still renders the execution-first contract', () => {
  const lines = qr.renderSpec({ profile: 'verify' });
  assert.ok(lines.length >= 2);
  assert.equal(lines.some(l => /LAYERED VERIFICATION/.test(l)), true);
});

test('renderSpec: verify profile is distinct from critic and worker (no cross-contamination)', () => {
  const verifyLines = qr.renderSpec({ profile: 'verify' });
  const criticLines = qr.renderSpec({ profile: 'critic' });
  assert.notDeepEqual(verifyLines, criticLines);
});

test('renderSpec: unknown riskTier is ignored defensively (defense in depth vs normalizeSpec)', () => {
  const lines = qr.renderSpec({ riskTier: 'extreme' });
  assert.equal(lines.some(l => l.startsWith('Risk tier:')), false);
});

test('launchHeader: with a spec, spec lines land between the card line and "Your task follows."', () => {
  const h = qr.launchHeader({
    job: { id: 'glmps-70', project: 'nq', spec: { deliverable: 'a fix', riskTier: 'low' } },
    port: 8123,
  });
  const lines = h.split('\n');
  const cardIdx = lines.findIndex(l => /^Backlog card glmps-70/.test(l));
  const taskIdx = lines.findIndex(l => l === 'Your task follows.');
  const deliverableIdx = lines.findIndex(l => l === 'Deliverable: a fix');
  assert.ok(cardIdx >= 0 && taskIdx >= 0 && deliverableIdx >= 0);
  assert.ok(deliverableIdx > cardIdx && deliverableIdx < taskIdx);
});

test('launchHeader: without a spec, output is byte-identical to the no-spec case', () => {
  const withoutSpecKey = qr.launchHeader({ job: { id: 'glmps-71', project: 'nq' }, port: 8123 });
  const withEmptySpec = qr.launchHeader({ job: { id: 'glmps-71', project: 'nq', spec: {} }, port: 8123 });
  const withNullSpec = qr.launchHeader({ job: { id: 'glmps-71', project: 'nq', spec: null }, port: 8123 });
  assert.equal(withoutSpecKey, withEmptySpec);
  assert.equal(withoutSpecKey, withNullSpec);
  assert.doesNotMatch(withoutSpecKey, /Deliverable:|Risk tier:|Escalate \(stop|CRITIC/);
});

test('actorForJob falls back to cfgActor, then "operator", for non-chat jobs', () => {
  assert.equal(qr.actorForJob({ job: {}, cfgActor: 'alice' }), 'alice');
  assert.equal(qr.actorForJob({ job: {} }), 'operator');
  assert.equal(qr.actorForJob({ job: { origin: { via: 'slack' } }, cfgActor: 'alice' }), 'alice'); // no user -> fallback
  assert.equal(qr.actorForJob({ job: { origin: { via: 'other', user: 'x' } }, cfgActor: 'alice' }), 'alice'); // non-slack origin
  // Discord retired 2026-08-29: a legacy discord row no longer attributes.
  assert.equal(qr.actorForJob({ job: { origin: { via: 'discord', user: 'operator-handle' } }, cfgActor: 'alice' }), 'alice');
  assert.equal(qr.actorForJob({}), 'operator');
});

test('actorForJob attributes a slack-origin job to the slack user', () => {
  assert.equal(qr.actorForJob({ job: { origin: { via: 'slack', user: 'U123' } }, cfgActor: 'operator' }), 'U123');
});

test('actorForJob still falls back when a slack origin has no user', () => {
  assert.equal(qr.actorForJob({ job: { origin: { via: 'slack' } }, cfgActor: 'operator' }), 'operator');
});


test('reconcileLedger: time spent blocked on an approval gate does not count as overrun', () => {
  // Without this, enabling long approval waits would make the runner requeue
  // every gated job at 30 minutes while its agent is alive and still waiting.
  const ledger = { j1: { pid: null, startedAt: 0, target: 'x', retries: 0 } };
  const items = [{ id: 'j1', state: 'in_progress' }];
  const base = { ledger, items, isAlive: () => true, now: 40 * 60_000, maxRuntimeMs: 30 * 60_000, maxRetries: 2 };

  const without = qr.reconcileLedger(base);
  assert.equal(without.actions[0]?.reason, 'timeout', 'baseline: 40min > 30min is an overrun');

  const withWait = qr.reconcileLedger({ ...base, gateWaitMs: (id) => (id === 'j1' ? 20 * 60_000 : 0) });
  assert.deepEqual(withWait.actions, [], '40min wall clock minus 20min waiting is 20min of work');
  assert.ok(withWait.ledger.j1, 'the job stays in the ledger, so its worktree stays protected');
});

test('reconcileLedger: gate wait does not rescue a genuinely overrunning job', () => {
  const ledger = { j1: { pid: null, startedAt: 0, target: 'x', retries: 0 } };
  const items = [{ id: 'j1', state: 'in_progress' }];
  const r = qr.reconcileLedger({
    ledger, items, isAlive: () => true, now: 90 * 60_000,
    maxRuntimeMs: 30 * 60_000, maxRetries: 2, gateWaitMs: () => 10 * 60_000,
  });
  assert.equal(r.actions[0]?.reason, 'timeout', '80min of actual work still overruns');
});

test('reconcileLedger: gateWaitMs is optional and defaults to no credit', () => {
  const ledger = { j1: { pid: null, startedAt: 0, target: 'x', retries: 0 } };
  const items = [{ id: 'j1', state: 'in_progress' }];
  const r = qr.reconcileLedger({ ledger, items, isAlive: () => true, now: 40 * 60_000, maxRuntimeMs: 30 * 60_000, maxRetries: 2 });
  assert.equal(r.actions[0]?.reason, 'timeout');
});

test('reconcileLedger: a throwing gateWaitMs never breaks reconcile', () => {
  const ledger = { j1: { pid: null, startedAt: 0, target: 'x', retries: 0 } };
  const items = [{ id: 'j1', state: 'in_progress' }];
  const r = qr.reconcileLedger({
    ledger, items, isAlive: () => true, now: 10 * 60_000,
    maxRuntimeMs: 30 * 60_000, maxRetries: 2,
    gateWaitMs: () => { throw new Error('control store unreadable'); },
  });
  assert.deepEqual(r.actions, [], 'degrades to zero credit, not to a crashed runner tick');
});


const ROUTES = { research: 'web-researcher', ui: 'ui-designer' };

test('explicit role wins over classification', () => {
  const r = resolveRoute({ job: { role: 'ui', prompt: 'investigate and compare caching options' }, routes: ROUTES });
  assert.equal(r.agent, 'ui-designer');
  assert.equal(r.via, 'explicit');
  assert.equal(r.confidence, 1);
});

test('classifies when no explicit role', () => {
  const r = resolveRoute({ job: { prompt: 'fix the dashboard layout and styling' }, routes: ROUTES });
  assert.equal(r.agent, 'ui-designer');
  assert.equal(r.taskClass, 'ui');
  assert.equal(r.via, 'classified');
});

test('a single weak keyword does not route despite confidence 1.0', () => {
  const r = resolveRoute({ job: { prompt: 'please check it' }, routes: ROUTES });
  assert.equal(r.agent, null);
  assert.equal(r.via, null);
});

test('an unmapped class does not route', () => {
  const r = resolveRoute({ job: { prompt: 'fix the failing auth bug', filesTouched: [] }, routes: ROUTES });
  assert.equal(r.agent, null);
});

test('empty routes disables routing entirely', () => {
  const r = resolveRoute({ job: { role: 'ui', prompt: 'restyle the grid' }, routes: {} });
  assert.equal(r.agent, null);
});

test('falls back to the title when the card has no prompt', () => {
  const r = resolveRoute({ job: { title: 'fix the dashboard layout and styling' }, routes: ROUTES });
  assert.equal(r.agent, 'ui-designer');
});

test('a classifier throw is caught and routes nothing', () => {
  const r = resolveRoute({ job: { prompt: { toLowerCase() { throw new Error('boom'); } } }, routes: ROUTES });
  assert.equal(r.agent, null);
});

test('a mapped class with a single weak keyword is blocked by minScore, not by an unmapped class', () => {
  // Regression guard for the confidence-vs-score distinction the brief calls
  // out as the crux of this task: 'review' (the class 'please check it' hits)
  // is not in ROUTES, so that assertion alone cannot prove minScore is doing
  // the blocking -- an implementation missing the minScore gate entirely would
  // still pass it, because the unmapped-class check catches it instead. This
  // case picks a MAPPED class ('research') with exactly one weak keyword, so
  // only the minScore gate (not the unmapped-class gate) can explain the null.
  // Re-derived by hand: "please compare it" matches only 'compare' (research);
  // filesTouched defaults to [] so the research pure-exploration boost applies
  // (1 * 1.5 = 1.5); sum = 1.5, so confidence = 1.5/1.5 = 1.0 but score = 1.5.
  //
  // The threshold is passed EXPLICITLY here as of 2026-08-12. It used to rely
  // on DEFAULT_ROUTE_MIN_SCORE being 2; that default is now 1 (roster re-cut),
  // and pinning this guard to the default would have made it silently change
  // meaning rather than fail. What it guards is the gate's existence, not the
  // number.
  const r = resolveRoute({ job: { prompt: 'please compare it' }, routes: ROUTES, minScore: 2 });
  assert.equal(r.agent, null);
  assert.equal(r.via, null);

  // And the other half of that contract: at the SHIPPED default of 1, the same
  // one-keyword card routes. This is the behavior change the re-cut is for, so
  // it gets an assertion rather than an assumption.
  const shipped = resolveRoute({ job: { prompt: 'please compare it' }, routes: ROUTES });
  assert.equal(shipped.agent, ROUTES.research);
  assert.equal(shipped.via, 'classified');
});

test('launchHeader tells the agent to declare its plan, and why ticking matters', () => {
  // glmps-74: the progress check-in is SERVER-driven, but it needs
  // one declaration to know its denominator. Without this line in the header
  // no agent would ever declare, and the feature would be inert - which is the
  // exact defect class this whole ticket was about.
  // The working agreement lives in the SEED DOC, not the launch header.
  const h = qr.buildSeedDoc({ id: 'x-1', title: 't', prompt: 'do a thing' }, { port: 8123 });
  assert.match(h, /\/api\/backlog\/x-1\/progress/, 'names the declare endpoint');
  assert.match(h, /plan/i);
  assert.match(h, /tick/i, 'and says the count comes from ticked boxes, so ticking is not optional');
});

// The operator is an engineering manager and asked, in his own words, not to
// get "intricate low level engineering terminology" in the CLI or in Slack.
// Measured on the live board at the time: 36% of agent devlogs named two or
// more internal identifiers in their FIRST line, so the defect is ordering,
// not volume. The seed prompt is the strongest lever available, because it is
// in context at the top of every session that will post into a thread.

test('buildSeedDoc: the working agreement states the reporting shape, not just the endpoint', () => {
  const doc = qr.buildSeedDoc({ id: 'mc-78', title: 'T', prompt: 'p' }, { port: 8123 });
  assert.match(doc, /engineering manager/i);
  assert.match(doc, /Details:/);                       // the fold marker is named literally
  assert.match(doc, /outcome/i);
  assert.match(doc, /identifier/i);                    // "no internal identifiers in the lead"
});

test('buildSeedDoc: raising the altitude is never licence to hide a problem', () => {
  const doc = qr.buildSeedDoc({ id: 'mc-78', title: 'T', prompt: 'p' }, { port: 8123 });
  // The watermelon-reporting guard. Without this the contract reads as
  // "summarize upward", which is exactly how bad news goes missing.
  assert.match(doc, /risk|blocker/i);
  assert.match(doc, /never|must not|do not/i);
});

test('launchHeader: a slack job gets the thread-specific cadence and length rules', () => {
  const h = qr.launchHeader({
    job: { id: 'mc-78', project: 'glmps', origin: { via: 'slack', channel: 'C1', thread_ts: '1.1' } },
    port: 8123,
  });
  assert.match(h, /1,?200/);                           // lead budget before the fold
  assert.match(h, /state change/i);                    // cadence: not per action
  assert.match(h, /phone|glance/i);                    // why the budget is tighter here
});

test('launchHeader: a job with no chat origin is not given the chat-only length/cadence rules', () => {
  const h = qr.launchHeader({ job: { id: 'mc-78', project: 'glmps' }, port: 8123 });
  assert.doesNotMatch(h, /state change/i);
});

// D32 G1: a card states its intent before work starts.
const slack = { via: 'slack', channel: 'C1', thread_ts: '111.1' };

test('intentFirstLines: a slack feature card with no ACs gets one grilling round', () => {
  const t = qr.intentFirstLines({ id: 'p-1', prompt: 'build a new export endpoint', origin: slack }, { port: 8123 }).join('\n');
  assert.match(t, /INTENT FIRST/);
  assert.match(t, /at most 5/);
  assert.match(t, /recommended answer/);
  assert.match(t, /acceptanceCriteria/);
  assert.match(t, /PATCH http:\/\/127\.0\.0\.1:8123\/api\/backlog\/p-1/);
});

test('intentFirstLines: a debug card gets the one-line intent, not a grilling round', () => {
  const t = qr.intentFirstLines({ id: 'p-2', prompt: 'fix the broken wiki build', origin: slack }, { port: 8123 }).join('\n');
  assert.match(t, /INTENT FIRST/);
  assert.match(t, /one line/);
  assert.doesNotMatch(t, /recommended answer/);
});

test('intentFirstLines: a card that already has ACs gets nothing', () => {
  assert.deepEqual(qr.intentFirstLines({ id: 'p-3', prompt: 'build x', origin: slack, acceptanceCriteria: [{ text: 'a' }] }, { port: 8123 }), []);
});

test('intentFirstLines: a non-slack feature card records its own ACs', () => {
  const t = qr.intentFirstLines({ id: 'p-4', prompt: 'build a new export endpoint' }, { port: 8123 }).join('\n');
  assert.match(t, /one line/);
  assert.doesNotMatch(t, /park/i);
});

test('launchHeader includes the intent lines before "Your task follows."', () => {
  const h = qr.launchHeader({ job: { id: 'p-5', project: 'p', prompt: 'build a new export endpoint', origin: slack }, port: 8123 });
  assert.ok(h.indexOf('INTENT FIRST') > -1 && h.indexOf('INTENT FIRST') < h.indexOf('Your task follows.'));
});

test('buildSeedDoc tells the agent to cite every AC in gate evidence and to stop on reintent', () => {
  const d = qr.buildSeedDoc({ id: 'p-6', title: 't', prompt: 'x' }, { port: 8123 });
  assert.match(d, /cite every acceptance criterion by number/);
  assert.match(d, /"reintent":true/);
});

test('pickNextJob skips a card whose gate asks for the intent', () => {
  const items = [
    { id: 'r', state: 'queued', order: 1, gate: { status: 'FAIL', reintent: true } },
    { id: 'ok', state: 'queued', order: 2 },
  ];
  assert.equal(qr.pickNextJob(items).id, 'ok');
});

test('blockedQueued lists a reintent card so the runner holds it visibly', () => {
  const items = [
    { id: 'r', state: 'queued', order: 1, gate: { status: 'FAIL', reintent: true } },
    { id: 'ok', state: 'queued', order: 2 },
  ];
  assert.deepEqual(qr.blockedQueued(items), [{ id: 'r', blockers: ['a restated intent (two failed gates in a row)'], forBlockers: false }]);
});

// glmps-2-0-75: a spec merged mid-conversation closed its card and stranded the operator's reply.
test('buildSeedDoc tells the author how to land an interim step without closing the card', () => {
  const doc = qr.buildSeedDoc({ id: 'glmps-9', title: 'T', prompt: 'p' }, { port: 8123 });
  assert.match(doc, /add "interim":true to that request: the merge then leaves this card open/);
});

test('buildSeedDoc explains covers and final on the merge request', () => {
  const doc = qr.buildSeedDoc({ id: 'glmps-9', title: 'T', prompt: 'p' }, { port: 8123 });
  assert.match(doc, /"covers":\[1,2\]/);
  assert.match(doc, /"final":true/);
  assert.match(doc, /closes this card only when every acceptance criterion has been covered/);
});

// Card glmps-2-0-163: only a child of an open host runs headless; every other
// card opens interactively (with its own channel). An explicit mode wins.
test('launchMode: headless only for a child of an open host, interactive for everything else, an explicit mode wins', () => {
  const op = { trust: 'operator' };
  const ext = { trust: 'external' };
  const items = [
    { id: 'host', state: 'in_progress' },
    { id: 'held-host', state: 'held' },
    { id: 'idle-host', state: 'idle' },
    { id: 'done-host', state: 'done' },
    { id: 'cancelled-host', state: 'cancelled' },
    { id: 'archived-host', state: 'archived' },
  ];
  const table = [
    [{ source: 'scut', provenance: op }, 'interactive', 'Slack mention'],
    [{ source: 'manual', provenance: op, parentId: 'host' }, 'headless', 'child of an open host'],
    [{ source: 'scut', provenance: op, parentId: 'held-host' }, 'headless', 'a held host is still open'],
    [{ source: 'deferred', provenance: ext, parentId: 'idle-host' }, 'headless', 'an idle host is still open'],
    [{ source: 'manual', provenance: op, parentId: 'done-host' }, 'interactive', 'host is done'],
    [{ source: 'manual', provenance: op, parentId: 'cancelled-host' }, 'interactive', 'host is cancelled'],
    [{ source: 'manual', provenance: op, parentId: 'archived-host' }, 'interactive', 'host is archived'],
    [{ source: 'manual', provenance: op, parentId: 'deleted' }, 'interactive', 'a parent that names no card is not an open host'],
    [{ source: 'manual', provenance: ext }, 'interactive', 'manual without operator trust'],
    [{ source: 'manual' }, 'interactive', 'no provenance'],
    [{ source: 'deferred', provenance: ext }, 'interactive', 'agent-filed deferral with no host'],
    [{ source: 'loop-diagnosis', provenance: op }, 'interactive', 'loop diagnosis'],
    [{ source: 'merge-queue' }, 'interactive', 'merge-queue review card'],
    [{}, 'interactive', 'empty card'],
    [{ source: 'deferred', provenance: ext, parentId: 'host', mode: 'interactive' }, 'interactive', 'explicit override up'],
    [{ source: 'scut', provenance: op, mode: 'headless' }, 'headless', 'explicit override down'],
    [{ source: 'scut', provenance: op, parentId: 'host', mode: 'bogus' }, 'headless', 'an invalid mode is ignored'],
    [{ source: 'scut', provenance: op, mode: null }, 'interactive', 'a cleared mode falls back to lineage'],
  ];
  for (const [card, want, why] of table) assert.equal(qr.launchMode(card, items), want, why);
  assert.equal(qr.launchMode(undefined, items), 'interactive');
  assert.equal(qr.launchMode({ parentId: 'host' }), 'interactive', 'with no board to look the host up in, no host is known to be open');
});

test('hostOpen and openChildren: a host is open until done, cancelled or archived; children are the open cards that name it', () => {
  const items = [
    { id: 'h', state: 'held' },
    { id: 'c1', state: 'in_progress', parentId: 'h' },
    { id: 'c2', state: 'held', parentId: 'h' },
    { id: 'c3', state: 'done', parentId: 'h' },
    { id: 'c4', state: 'cancelled', parentId: 'h' },
    { id: 'other', state: 'queued', parentId: 'x' },
  ];
  assert.equal(qr.hostOpen({ parentId: 'h' }, items), true);
  assert.equal(qr.hostOpen({ parentId: 'c3' }, items), false);
  assert.equal(qr.hostOpen({ parentId: 'nope' }, items), false);
  assert.equal(qr.hostOpen({}, items), false);
  assert.deepEqual(qr.openChildren('h', items).map((c) => c.id), ['c1', 'c2']);
  assert.deepEqual(qr.openChildren('c1', items), []);
});

test('reconcileLedger: a headless run holds its slot only while it lives, and on exit a gate releases it, no gate holds it', () => {
  const T = Date.parse('2026-10-23T10:00:00.000Z');
  const e = (over = {}) => ({ pid: null, startedAt: T, retries: 0, headless: true, ...over });
  const card = (id, over = {}) => ({ id, state: 'in_progress', ...over });
  const live = new Set(['running', 'overrun', 'nearly']);
  const out = qr.reconcileLedger({
    ledger: {
      running: e(), overrun: e({ startedAt: T - 100_000 }), nearly: e({ startedAt: T - 29_000 }),
      gated: e(), crashed: e(), stale: e(), done: e(), legacy: { pid: null, startedAt: T - 100_000, retries: 0 },
    },
    items: [
      card('running'), card('overrun'), card('nearly'),
      card('gated', { gate: { status: 'CONCERNS', ts: '2026-10-23T10:00:00.500Z' } }),
      card('crashed'),
      card('stale', { gate: { status: 'PASS', ts: '2026-10-22T09:00:00.000Z' } }),
      card('done', { state: 'done' }), card('legacy'),
    ],
    isAlive: () => false,
    headlessLive: (id) => live.has(id),
    headlessSlackMs: 60_000,
    now: T + 31_000, maxRuntimeMs: 1000, maxRetries: 2,
  });
  assert.deepEqual(Object.keys(out.ledger).sort(), ['legacy', 'nearly', 'running'], 'live headless runs inside the cap plus slack keep a slot; the requeued legacy entry keeps its lease');
  const acts = Object.fromEntries(out.actions.map((a) => [a.id, a]));
  assert.deepEqual(acts.overrun, { id: 'overrun', action: 'hold', reason: 'timeout' }, 'a runaway is held and reported, never requeued beside itself');
  assert.deepEqual(acts.gated, { id: 'gated', action: 'release', reason: 'headless run ended with a gate' });
  assert.deepEqual(acts.crashed, { id: 'crashed', action: 'hold', reason: 'headless run exited without a gate' });
  assert.deepEqual(acts.stale, { id: 'stale', action: 'hold', reason: 'headless run exited without a gate' }, 'a gate from an earlier run does not count');
  assert.equal(acts.done, undefined);
  assert.equal(acts.running, undefined);
  assert.equal(acts.nearly, undefined);
  assert.equal(acts.legacy.action, 'requeue', 'a non-headless entry keeps the old rules');
});

test('reconcileLedger: with no liveness probe a headless entry is treated as live', () => {
  const out = qr.reconcileLedger({
    ledger: { a: { pid: null, startedAt: 0, retries: 0, headless: true } },
    items: [{ id: 'a', state: 'in_progress' }],
    isAlive: () => false, now: 10, maxRuntimeMs: 1000, maxRetries: 2,
  });
  assert.deepEqual(Object.keys(out.ledger), ['a']);
  assert.deepEqual(out.actions, []);
});

test('launchHeader: a headless Slack card gets no park loop; it posts, records the gate and ends, and a reply resumes it', () => {
  const job = { id: 'glmps-12', project: 'nq', origin: { via: 'slack', channel: 'C1', thread_ts: '111.1' } };
  const h = qr.launchHeader({ job, port: 8123, headless: true });
  assert.doesNotMatch(h, /THREAD CONTINUITY|\/api\/scut\/park with body/);
  assert.match(h, /OWN the reply/, 'it still owns the thread');
  assert.match(h, /HEADLESS RUN/);
  assert.match(h, /never POST \/api\/scut\/park/);
  assert.match(h, /post the question as a devlog, record a gate/i);
  assert.match(h, /resumes this same session/);
  const interactive = qr.launchHeader({ job, port: 8123 });
  assert.match(interactive, /THREAD CONTINUITY/);
  assert.doesNotMatch(interactive, /HEADLESS RUN/);
  const plain = qr.launchHeader({ job: { id: 'glmps-13', project: 'nq' }, port: 8123, headless: true });
  assert.match(plain, /HEADLESS RUN/, 'a headless card with no thread is told the same, minus Slack');
});

// glmps-2-0-105 answered a Monitor notification that arrived mid park loop,
// ended its turn without polling again, and was released stale 25 minutes
// later with nobody listening for the operator's reply.
test('launchHeader: the park loop says an interruption is handled and followed by the next poll, never an ended turn', () => {
  const job = { id: 'glmps-14', project: 'nq', origin: { via: 'slack', channel: 'C1', thread_ts: '111.1' } };
  const h = qr.launchHeader({ job, port: 8123 });
  assert.match(h, /Only handoff, close or that failed retry ends the loop/);
  assert.match(h, /Monitor notification/);
  assert.match(h, /followed by the next poll in the same turn/);
});

test('launchHeader: a headless feature card with no criteria and a chat thread ends after its grilling round instead of parking', () => {
  const job = { id: 'glmps-14', project: 'nq', prompt: 'implement a new feature', origin: { via: 'slack', channel: 'C1', thread_ts: '1.1' } };
  const h = qr.launchHeader({ job, port: 8123, headless: true });
  assert.match(h, /grilling round/);
  assert.doesNotMatch(h, /Then park as described above/);
  assert.match(h, /Then end as described above/);
  assert.match(qr.launchHeader({ job, port: 8123 }), /Then park as described above/);
});

test('buildSeedDoc tells the agent to name its card as the parent of any card it files', () => {
  const doc = qr.buildSeedDoc({ id: 'glmps-9', title: 'T', prompt: 'p' }, { port: 8123 });
  assert.match(doc, /"parentId":"glmps-9"/);
});

test('reopenSeedSection: a headless resume is told to end, not to park again', () => {
  const s = qr.reopenSeedSection({ note: 'go on', branch: 'b', headless: true });
  assert.doesNotMatch(s, /park again/);
  assert.match(s, /record a gate, then end/);
  assert.match(qr.reopenSeedSection({ note: 'go on', branch: 'b' }), /park again/);
});

test('releasableHeld: an auto-held card returns once its last blocker is done or archived (glmps-2-0-runtime-61 AC-1)', () => {
  const items = [
    { id: 'a', state: 'done' },
    { id: 'b', state: 'archived' },
    { id: 'c', state: 'in_progress' },
    { id: 'free', state: 'held', autoHeldForBlockers: true, blockedBy: ['a', 'b'] },
    { id: 'still', state: 'held', autoHeldForBlockers: true, blockedBy: ['a', 'c'] },
  ];
  assert.deepEqual(qr.releasableHeld(items), [{ id: 'free', resolved: ['a', 'b'] }]);
  items[2].state = 'done';
  assert.deepEqual(qr.releasableHeld(items).map(r => r.id), ['free', 'still']);
});

test('releasableHeld never releases an operator-held card or one held for another reason (AC-2)', () => {
  const items = [
    { id: 'a', state: 'done' },
    { id: 'op', state: 'held', blockedBy: ['a'] },
    { id: 'flagFalse', state: 'held', autoHeldForBlockers: false, blockedBy: ['a'] },
    { id: 'reintent', state: 'held', autoHeldForBlockers: true, blockedBy: ['a'], gate: { reintent: true } },
    { id: 'notHeld', state: 'queued', autoHeldForBlockers: true, blockedBy: ['a'] },
  ];
  assert.deepEqual(qr.releasableHeld(items), []);
});

test('blockedQueued marks a mixed blocker-and-reintent hold as not for blockers', () => {
  const items = [
    { id: 'x', state: 'in_progress' },
    { id: 'm', state: 'queued', blockedBy: ['x'], gate: { reintent: true } },
  ];
  assert.equal(qr.blockedQueued(items)[0].forBlockers, false);
});

test('releasableHeld bridges a pre-flag runner hold only while nothing has touched the card since', () => {
  const ts = '2026-10-25T10:00:00.000Z';
  const hold = { ts, text: 'runner: auto-held \u2014 blocked by a' };
  const items = [
    { id: 'a', state: 'done' },
    { id: 'legacy', state: 'held', blockedBy: ['a'], updatedAt: ts, activity: [hold] },
    { id: 'editedSince', state: 'held', blockedBy: ['a'], updatedAt: '2026-10-25T11:00:00.000Z', activity: [hold] },
    { id: 'flaggedOff', state: 'held', autoHeldForBlockers: false, blockedBy: ['a'], updatedAt: ts, activity: [hold] },
    { id: 'otherHold', state: 'held', blockedBy: ['a'], updatedAt: ts, activity: [{ ts, text: 'runner: auto-held \u2014 blocked by a restated intent (two failed gates in a row)' }] },
    { id: 'opHeld', state: 'held', blockedBy: ['a'], updatedAt: ts, activity: [] },
  ];
  assert.deepEqual(qr.releasableHeld(items).map(r => r.id), ['legacy']);
});

test('the launch header names the operator timezone and the rule for writing times (card glmps-2-0-runtime-66)', () => {
  const h = qr.launchHeader({ job: { id: 'c-1', project: 'p' }, port: 8123, timeZone: 'America/Los_Angeles' });
  assert.match(h, /OPERATOR TIMEZONE: America\/Los_Angeles \(PT\)\. Write times for the operator in America\/Los_Angeles, with the zone named \(for example "4:22 PM PT"\); never Z or UTC in prose\./);
  assert.equal(qr.launchHeader({ job: { id: 'c-1', project: 'p' }, port: 8123 }).includes('OPERATOR TIMEZONE'), false, 'no zone, no line');
  assert.match(qr.timeZoneLine('Europe/Berlin'), /\(GMT\+1\).*"1:22 AM GMT\+1"/);
});

const SKILL_VOCAB = {
  cues: [{ skill: 'tdd', phrases: ['test first'] }, { skill: 'to-spec', phrases: ['spec it'] }],
  defaults: { debug: 'diagnosing-bugs', feature: 'tdd', other: 'grill-me' },
};

test('resolveSkills: an explicit cue wins over the route class', () => {
  const r = qr.resolveSkills({ job: { prompt: 'fix the failing auth bug, spec it first' }, route: { taskClass: 'debug' }, vocab: SKILL_VOCAB });
  assert.deepEqual(r, { skills: ['to-spec'], via: 'cue' });
});

test('resolveSkills: a reopen reply cue outranks the card text; a cue-less reply falls back to it', () => {
  const job = { prompt: 'spec it' };
  assert.deepEqual(qr.resolveSkills({ job, route: null, vocab: SKILL_VOCAB, reply: 'do it test-first' }), { skills: ['tdd'], via: 'cue' });
  assert.deepEqual(qr.resolveSkills({ job, route: null, vocab: SKILL_VOCAB, reply: 'thanks' }), { skills: ['to-spec'], via: 'cue' });
});

test('operatorReply: only an operator or Slack reopen counts as the operator\'s words', () => {
  assert.equal(qr.operatorReply({ note: 'spec it', source: 'operator' }), 'spec it');
  assert.equal(qr.operatorReply({ note: 'spec it' }), 'spec it', 'the Slack reopen loop sets no source');
  assert.equal(qr.operatorReply({ note: 'review the diff', source: 'merge-reviewer' }), null);
  assert.equal(qr.operatorReply({ note: 'diagnose this', source: 'merge-queue' }), null);
  assert.equal(qr.operatorReply(null), null);
  const job = { prompt: 'hello' };
  const r = qr.resolveSkills({ job, route: { taskClass: 'debug' }, vocab: SKILL_VOCAB, reply: qr.operatorReply({ note: 'do it test-first', source: 'merge-reviewer' }) });
  assert.deepEqual(r, { skills: ['diagnosing-bugs'], via: 'class' });
});

test('resolveSkills: operator words count in a Slack card, not in an agent-filed one', () => {
  const vocab = { ...SKILL_VOCAB, operatorCues: [{ skill: 'research', phrases: ['research'] }] };
  const text = 'research the best ui skills';
  assert.deepEqual(qr.resolveSkills({ job: { prompt: text, origin: { via: 'slack' } }, route: null, vocab }), { skills: ['research'], via: 'cue' });
  assert.notEqual(qr.resolveSkills({ job: { prompt: text, source: 'deferred' }, route: null, vocab }).via, 'cue');
  assert.deepEqual(qr.resolveSkills({ job: { prompt: 'hello' }, route: null, vocab, reply: 'research it' }), { skills: ['research'], via: 'cue' });
});

test('resolveSkills: no cue takes the routed class default, else the classifier class', () => {
  assert.deepEqual(qr.resolveSkills({ job: { prompt: 'hello' }, route: { taskClass: 'debug' }, vocab: SKILL_VOCAB }), { skills: ['diagnosing-bugs'], via: 'class' });
  const r = qr.resolveSkills({ job: { prompt: 'fix the failing auth bug and the crash' }, route: null, vocab: SKILL_VOCAB });
  assert.equal(r.via, 'class');
});

test('resolveSkills: an empty vocabulary yields none and never throws', () => {
  assert.deepEqual(qr.resolveSkills({ job: { prompt: 'spec it' }, route: null, vocab: { cues: [], defaults: {} } }), { skills: [], via: 'none' });
  assert.deepEqual(qr.resolveSkills({ job: null, route: null, vocab: null }), { skills: [], via: 'none' });
});

test('launchHeader: a cued skill is mandatory, right after ROUTING', () => {
  const h = qr.launchHeader({
    job: { id: 'x-1', project: 'p' }, port: 8123,
    route: { agent: 'ui-designer', taskClass: 'ui', confidence: 0.8 },
    skills: { skills: ['tdd', 'to-spec'], via: 'cue' },
  });
  const lines = h.split('\n');
  const i = lines.findIndex((l) => l.startsWith('ROUTING:'));
  assert.ok(lines[i + 1].startsWith('SKILLS:'), 'SKILLS directly after ROUTING');
  assert.match(lines[i + 1], /cues the `tdd`, `to-spec` skills?: invoking (it|them) is mandatory/);
  assert.match(lines[i + 1], /Skill tool/);
  assert.match(lines[i + 1], /mattpocock-skills:X/);
  assert.match(lines[i + 1], /tell any subagent you dispatch to invoke it too/);
  assert.match(lines[i + 1], /name the skill you ran in your devlog posts/);
});

test('launchHeader: a class skill is only a suggestion', () => {
  const h = qr.launchHeader({ job: { id: 'x-1', project: 'p' }, port: 8123, skills: { skills: ['tdd'], via: 'class' } });
  assert.match(h, /SKILLS: This card's class suggests the `tdd` skill: invoke it unless the card's wording points elsewhere/);
  assert.doesNotMatch(h, /mandatory/);
});

test('launchHeader: no skills means no SKILLS line, and routing output is untouched', () => {
  const job = { id: 'x-1', project: 'p' };
  const route = { agent: 'ui-designer', taskClass: 'ui', confidence: 0.8 };
  const base = qr.launchHeader({ job, port: 8123, route });
  assert.doesNotMatch(base, /SKILLS:/);
  assert.equal(qr.launchHeader({ job, port: 8123, route, skills: { skills: [], via: 'none' } }), base);
  assert.equal(qr.launchHeader({ job, port: 8123, route, skills: null }), base);
});

test('launchHeader: the park paragraph says a wake may carry skills', () => {
  const h = qr.launchHeader({ job: { id: 'x-1', project: 'p', origin: { via: 'slack', channel: 'C1', thread_ts: '1.1' } }, port: 8123 });
  assert.match(h, /"skills":\[\.\.\.\]/);
  assert.match(h, /mandatory for that note's work/);
});

test('intent-first grilling round names the grilling skill', () => {
  const lines = qr.intentFirstLines({ id: 'x-1', prompt: 'build a new export endpoint', origin: { via: 'slack', channel: 'C1', thread_ts: '1.1' } }, { port: 8123 });
  assert.match(lines[0], /`grilling` skill/);
});

// glmps-2-0-111: 3 automation slots plus 1 reserved for operator cards.
const opCard = (id, order) => ({ id, state: 'queued', order, source: 'scut', provenance: { trust: 'operator' } });
const autoCard = (id, order) => ({ id, state: 'queued', order, source: 'deferred', provenance: { trust: 'operator' } });

test('isOperatorCard: operator-started primary cards only; a child card or untrusted sender is automation', () => {
  assert.equal(qr.isOperatorCard(opCard('a', 1)), true);
  assert.equal(qr.isOperatorCard({ ...opCard('a', 1), parentId: 'p' }), false);
  assert.equal(qr.isOperatorCard({ ...opCard('a', 1), provenance: { trust: 'external' } }), false);
  assert.equal(qr.isOperatorCard(autoCard('a', 1)), false);
  assert.equal(qr.isOperatorCard(undefined), false);
});

test('hasCapacity: 3 automation running leaves the operator lane open, and only for operator cards', () => {
  const items = [autoCard('a1', 1), autoCard('a2', 2), autoCard('a3', 3), opCard('o1', 4), opCard('o2', 5), autoCard('a4', 6)];
  const cfg = { maxConcurrent: 3, operatorSlots: 1 };
  const ledger = { a1: {}, a2: {}, a3: {}, rv: { role: 'reviewer' } };
  let usage = qr.slotUsage({ ledger, items });
  assert.deepEqual(usage, { auto: 3, operator: 0 });
  assert.equal(qr.hasCapacity({ usage, ...cfg }), false, '4th automation card refused');
  assert.equal(qr.hasCapacity({ usage, ...cfg, forOperator: true }), true, 'operator card fits the reserved lane');
  usage = qr.slotUsage({ ledger, launching: ['o1'], items });
  assert.equal(qr.hasCapacity({ usage, ...cfg, forOperator: true }), false, '2nd operator card refused at 4 total');
  assert.equal(qr.slotUsage({ ledger, launching: ['o1'], items, except: 'o1' }).operator, 0);
});

test('hasCapacity: operator sessions spill into the automation pool past their lane; default operatorSlots 0 is one shared pool', () => {
  const items = [opCard('o1', 1), opCard('o2', 2), autoCard('a1', 3)];
  const usage = qr.slotUsage({ ledger: { o1: {}, o2: {}, a1: {} }, items });
  assert.equal(qr.hasCapacity({ usage, maxConcurrent: 3, operatorSlots: 1 }), true, '1 op in lane, 1 op + 1 auto in pool: 1 auto slot left');
  assert.equal(qr.hasCapacity({ usage, maxConcurrent: 3, operatorSlots: 0 }), false);
  assert.equal(qr.hasCapacity({ usage, maxConcurrent: 3, forOperator: true }), false);
  assert.equal(qr.hasCapacity({ usage: { auto: 0, operator: 0 }, maxConcurrent: 1 }), true);
});

test('pickNextJob: preferOperator puts an operator card ahead of earlier automation cards; operatorOnly skips automation', () => {
  const items = [autoCard('a1', 1), autoCard('a2', 2), opCard('o1', 9)];
  assert.equal(qr.pickNextJob(items).id, 'a1', 'order alone when not preferring');
  assert.equal(qr.pickNextJob(items, [], { preferOperator: true }).id, 'o1');
  assert.equal(qr.pickNextJob(items, ['o1'], { operatorOnly: true }), null);
  assert.equal(qr.pickNextJob([...items, opCard('o0', 5)], [], { operatorOnly: true }).id, 'o0');
});

test('buildSeedDoc: tells a session that files a card it will work itself to file it in_progress', () => {
  const h = qr.buildSeedDoc({ id: 'glmps-7', project: 'nq' }, { port: 8123 });
  assert.match(h, /"parentId":"glmps-7"/);
  assert.match(h, /"state":"in_progress"/);
});

// glmps-2-0-128: agents never self-file follow-ups; questions offer to build on the same card; one PR.
test('buildSeedDoc: no self-filing rule names operatorApproved, outOfScope and the devlog list', () => {
  const doc = qr.buildSeedDoc({ id: 'glmps-9', title: 'T', prompt: 'p' }, { port: 8123 });
  assert.match(doc, /Do not file follow-up cards on your own/);
  assert.match(doc, /Found while working: 1\. \.\.\. 2\. \.\.\./);
  assert.match(doc, /"operatorApproved":true and "outOfScope":"<why>"/);
  assert.match(doc, /A queue run, triage or review card delivers that list as its result/);
  assert.doesNotMatch(doc, /If you file a new card on the board/);
});

test('buildSeedDoc: a question card offers to build the fix on the same card', () => {
  const doc = qr.buildSeedDoc({ id: 'glmps-9', title: 'T', prompt: 'p' }, { port: 8123 });
  assert.match(doc, /Reply 'build it' and I will do it on this card\./);
  assert.match(doc, /with "interim":true so this card stays open/);
});

test('buildSeedDoc: one change ships as one pull request per repo', () => {
  const doc = qr.buildSeedDoc({ id: 'glmps-9', title: 'T', prompt: 'p' }, { port: 8123 });
  assert.match(doc, /ONE pull request per repo: one change, one PR/);
});

test('buildSeedDoc describes the merge queue as it is: affected tests, load hold, red-base pause, no per-PR reviewer (glmps-2-0-runtime-125)', () => {
  const doc = qr.buildSeedDoc({ id: 'glmps-9', title: 'T', prompt: 'p' }, { port: 8123 });
  assert.match(doc, /runs the tests your PR affects/);
  assert.match(doc, /a timeout is requeued as load/i);
  assert.match(doc, /full suite is red/);
  assert.match(doc, /no per-PR reviewer/);
  assert.doesNotMatch(doc, /independent reviewer check it/);
  assert.doesNotMatch(doc, /If the reviewer asks for changes/);
});

test('buildSeedDoc: a host card that spawns runtime tickets stays open, avoids self-blocking, and relays child status and questions to Slack', () => {
  const doc = qr.buildSeedDoc({ id: 'glmps-2-0-135', title: 'T', prompt: 'p' }, { port: 8123 });
  assert.match(doc, /stateless headless/);
  assert.match(doc, /stay open until every spawned runtime card is done or cancelled/i);
  assert.match(doc, /never put "glmps-2-0-135" in a child card's "blockedBy"/i);
  assert.match(doc, /relay the child's question/i);
});

// glmps-2-0-185: engineer-to-manager reinforcement.
test('launchHeader: ROUTING names the inline exception and the Routing note line', () => {
  const h = qr.launchHeader({
    job: { id: 'x-1', project: 'p' }, port: 8123,
    route: { agent: 'debugger', taskClass: 'debug', confidence: 0.9, via: 'classified' },
  });
  const line = h.split('\n').find((l) => l.startsWith('ROUTING:'));
  assert.match(line, /one or two files or a bug you have already reproduced/);
  assert.match(line, /"Routing note:"/);
});

test('launchHeader: a class skill runs after the intent round, not instead of it', () => {
  const h = qr.launchHeader({ job: { id: 'x-1', project: 'p' }, port: 8123, skills: { skills: ['research'], via: 'class' } });
  assert.match(h, /an intent-first round does not replace it/);
});

test('intentFirstLines: the grilling round asks only operator-owned questions and may ask none', () => {
  const t = qr.intentFirstLines({ id: 'p-1', prompt: 'build a new export endpoint', origin: slack }, { port: 8123 }).join('\n');
  assert.match(t, /only about decisions that are the operator's/);
  assert.match(t, /"I will \.\.\." lines/);
  assert.match(t, /If no question is the operator's, ask none/);
});

test('buildSeedDoc: the working agreement carries the decision-ownership rule', () => {
  const doc = qr.buildSeedDoc({ id: 'glmps-9', title: 'T', prompt: 'p' }, { port: 8123 });
  assert.match(doc, /Ask the operator only what is the operator's to decide/);
  assert.match(doc, /"I will X unless you say otherwise"/);
  assert.match(doc, /Every question you do ask carries your recommended answer/);
  assert.match(doc, /read this card's devlog \(and its parent card's\) for an earlier answer/);
});

test('buildSeedDoc: follow-up items carry a recommendation and the gate summary a risk and verified line', () => {
  const doc = qr.buildSeedDoc({ id: 'glmps-9', title: 'T', prompt: 'p' }, { port: 8123 });
  assert.match(doc, /"Recommend: file" or "Recommend: skip"/);
  assert.match(doc, /one sentence starting "Risk:"/);
  assert.match(doc, /one starting "Verified:"/);
});

test('buildSeedDoc: agents never ask the operator to edit a file', () => {
  const doc = qr.buildSeedDoc({ id: 'glmps-9', title: 'T', prompt: 'p' }, { port: 8123 });
  assert.match(doc, /Never ask the operator to edit a file/);
  assert.match(doc, /make the edit yourself, and link the file you changed/);
});
