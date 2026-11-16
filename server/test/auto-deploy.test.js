import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoDeployDue, liveCandidates, liveNotices, deployActionFor, mergeIsLive } from '../lib/orchestration/auto-deploy.js';
import { approvalsConfig } from '../lib/scut/approvals.js';

const { registry } = approvalsConfig({});
const KEY = 'wolfeb-dev/glmps@glmps2/main';
const CFG = { [KEY]: 'deploy-glmps2' };
const T = Date.parse('2026-10-20T03:00:00.000Z');
const merged = (id, at, { repo = 'wolfeb-dev/glmps', base = 'glmps2/main' } = {}) => ({
  id, mergeRequest: { repo, base, stage: 'merged', mergeSha: `sha-${id}`, history: [{ ts: '2026-10-20T01:00:00.000Z', to: 'requested' }, { ts: new Date(at).toISOString(), to: 'merged' }] },
});
const run = (at, finished = true) => [
  { type: 'request', id: `r${at}`, action: 'deploy-glmps2', ts: at },
  { type: 'run-started', id: `r${at}`, action: 'deploy-glmps2', ts: at },
  ...(finished ? [{ type: 'run-finished', id: `r${at}`, action: 'deploy-glmps2', ts: at + 1000, result: { ok: true } }] : []),
];

test('off without config', () => {
  assert.equal(autoDeployDue({ items: [merged('a', T - 1000)], entries: [], autoDeploy: undefined, registry, now: T }).due, false);
  assert.equal(autoDeployDue({ items: [merged('a', T - 1000)], entries: [], autoDeploy: {}, registry, now: T }).due, false);
});

test('due on a queue merge newer than the last run, naming the newest merge card', () => {
  const r = autoDeployDue({ items: [merged('a', T - 5000), merged('b', T - 1000)], entries: run(T - 3 * 3600_000), autoDeploy: CFG, registry, now: T });
  assert.deepEqual(r, { due: true, action: 'deploy-glmps2', source: 'merge', ticketId: 'b', mergeSha: 'sha-b', mergeTs: T - 1000 });
});

test('not due when the newest run started after the newest merge', () => {
  assert.equal(autoDeployDue({ items: [merged('a', T - 5000)], entries: run(T - 4000), autoDeploy: CFG, registry, now: T + 3600_000 }).due, false);
});

test('a running or cooling-down action waits', () => {
  const items = [merged('a', T - 1000)];
  assert.equal(autoDeployDue({ items, entries: run(T - 2 * 60_000, false), autoDeploy: CFG, registry, now: T }).reason, 'action-running');
  assert.equal(autoDeployDue({ items: [merged('a', T)], entries: run(T - 10 * 60_000), autoDeploy: CFG, registry, now: T + 1000 }).reason, 'cooldown');
});

test('other repos and bases, unmerged requests and unknown actions are ignored', () => {
  const items = [merged('x', T - 1000, { repo: 'wolfeb-dev/glmps-2.0', base: 'main' }), merged('y', T - 1000, { base: 'main' }),
    { id: 'z', mergeRequest: { repo: 'wolfeb-dev/glmps', base: 'glmps2/main', stage: 'reviewing', history: [] } }];
  assert.equal(autoDeployDue({ items, entries: [], autoDeploy: CFG, registry, now: T }).due, false);
  assert.equal(autoDeployDue({ items: [merged('a', T - 1000)], entries: [], autoDeploy: { [KEY]: 'nope' }, registry, now: T }).reason, 'unknown-action');
});

test('a PR merged outside the queue is not auto-deployed (glmps-2-0-76)', () => {
  const outside = merged('a', T - 1000);
  outside.mergeRequest.mergedOutsideQueue = true;
  assert.equal(autoDeployDue({ items: [outside], entries: [], autoDeploy: CFG, registry, now: T }).due, false);
  const r = autoDeployDue({ items: [merged('q', T - 5000), outside], entries: [], autoDeploy: CFG, registry, now: T });
  assert.equal(r.ticketId, 'q', 'an earlier queue merge is still deployed');
});

// card glmps-2-0-runtime-52: an approved lesson pushed to a configured base is a second deploy source.
const lesson = (id, at, { repo = 'wolfeb-dev/glmps', branch = 'glmps2/main', status = 'applied', pushed = true } = {}) => ({
  id, status, ...(pushed ? { pushed: { repo, branch, sha: `ls-${id}`, ts: at } } : {}),
});

test('a pushed lesson newer than the last run is due, ticketless', () => {
  const r = autoDeployDue({ items: [], lessons: [lesson('L1', T - 1000)], entries: run(T - 3 * 3600_000), autoDeploy: CFG, registry, now: T });
  assert.deepEqual(r, { due: true, action: 'deploy-glmps2', source: 'lesson', lessonId: 'L1', ticketId: null, mergeSha: 'ls-L1', mergeTs: T - 1000 });
});

test('a lesson older than the last run is not due', () => {
  assert.equal(autoDeployDue({ items: [], lessons: [lesson('L1', T - 5000)], entries: run(T - 4000), autoDeploy: CFG, registry, now: T + 3600_000 }).due, false);
});

test('a lesson for another repo or branch is ignored', () => {
  const lessons = [lesson('a', T - 1000, { repo: 'wolfeb-dev/other' }), lesson('b', T - 1000, { branch: 'main' })];
  assert.equal(autoDeployDue({ items: [], lessons, entries: [], autoDeploy: CFG, registry, now: T }).due, false);
});

test('lessons that are not applied or were never pushed are ignored', () => {
  const lessons = [lesson('a', T - 1000, { status: 'failed' }), lesson('b', T - 1000, { pushed: false })];
  assert.equal(autoDeployDue({ items: [], lessons, entries: [], autoDeploy: CFG, registry, now: T }).due, false);
});

test('a busy action makes a due lesson wait', () => {
  const r = autoDeployDue({ items: [], lessons: [lesson('L1', T - 1000)], entries: run(T - 2 * 60_000, false), autoDeploy: CFG, registry, now: T });
  assert.equal(r.due, false);
  assert.equal(r.reason, 'action-running');
});

test('the newest of a queue merge and a lesson wins', () => {
  const old = autoDeployDue({ items: [merged('q', T - 1000)], lessons: [lesson('L1', T - 9000)], entries: [], autoDeploy: CFG, registry, now: T });
  assert.equal(old.source, 'merge');
  assert.equal(old.ticketId, 'q');
  const fresh = autoDeployDue({ items: [merged('q', T - 9000)], lessons: [lesson('L1', T - 1000)], entries: [], autoDeploy: CFG, registry, now: T });
  assert.equal(fresh.source, 'lesson');
});

test('a different registered action running makes the deploy wait, not crash', () => {
  const entries = [
    { type: 'request', id: 'rb', action: 'rebuild-app', ts: T - 60_000 },
    { type: 'run-started', id: 'rb', action: 'rebuild-app', ts: T - 60_000 },
  ];
  const r = autoDeployDue({ items: [merged('a', T - 1000)], entries, autoDeploy: CFG, registry, now: T });
  assert.deepEqual([r.due, r.reason], [false, 'another-action-running']);
});

// Card glmps-2-0-173 (B): a green full run deploys by itself, so a fix merged
// before main was certified is not stranded until some later merge.
test('a green full run newer than the last deploy run is due, on the newest merged card', () => {
  const items = [merged('a', T - 5 * 3600_000)];
  const greens = { [KEY]: { sha: 'green-1', ts: T - 1000 } };
  const r = autoDeployDue({ items, greens, entries: run(T - 4 * 3600_000), autoDeploy: CFG, registry, now: T });
  assert.deepEqual(r, { due: true, action: 'deploy-glmps2', source: 'green', ticketId: 'a', mergeSha: 'green-1', mergeTs: T - 1000 });
});

test('a green full run is not due when a deploy ran after it or the live build already is that commit', () => {
  const items = [merged('a', T - 5 * 3600_000)];
  const greens = { [KEY]: { sha: 'green-1abcdef', ts: T - 3 * 3600_000 } };
  assert.equal(autoDeployDue({ items, greens, entries: run(T - 2 * 3600_000), autoDeploy: CFG, registry, now: T }).due, false);
  assert.equal(autoDeployDue({ items, greens, liveSha: 'green-1', entries: run(T - 4 * 3600_000), autoDeploy: CFG, registry, now: T }).due, false);
  assert.equal(autoDeployDue({ items: [], greens, entries: [], autoDeploy: CFG, registry, now: T }).due, true, 'a green with no merge on record still deploys');
});

// Card glmps-2-0-173 (B): each queue merge says once when it is live, and once
// when a deploy finished without it, so a change is never silently stranded.
const withPr = (card, n) => ({ ...card, mergeRequest: { ...card.mergeRequest, number: n } });

test('liveCandidates: queue merges into a deploy-configured branch, recent, not yet marked live', () => {
  const live = merged('done', T - 1000); live.mergeRequest.live = { sha: 'x', ts: T };
  const outside = merged('out', T - 1000); outside.mergeRequest.mergedOutsideQueue = true;
  const items = [merged('a', T - 1000), live, outside, merged('old', T - 8 * 24 * 3600_000), merged('other', T - 1000, { base: 'main' })];
  assert.deepEqual(liveCandidates({ items, autoDeploy: CFG, now: T }).map((c) => c.id), ['a']);
  assert.equal(deployActionFor({ repo: 'Wolfeb-Dev/GLMPS', base: 'glmps2/main' }, CFG), 'deploy-glmps2');
  assert.equal(deployActionFor({ repo: 'wolfeb-dev/glmps', base: 'main' }, CFG), null);
});

test('a merge in the running build is marked live with one post naming both commits', () => {
  const items = [withPr(merged('a', T - 1000), 7)];
  const out = liveNotices({ items, inBuild: new Set(['sha-a']), liveSha: 'live123', entries: [], autoDeploy: CFG, now: T, tz: 'America/Los_Angeles' });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].mr.live, { sha: 'live123', ts: T });
  assert.match(out[0].text, /^Live: wolfeb-dev\/glmps#7 \(merge sha-a\) is in the running build live123 as of .+ PT\.$/);
  const again = liveNotices({ items: [{ ...items[0], mergeRequest: out[0].mr }], inBuild: new Set(['sha-a']), liveSha: 'live123', entries: [], autoDeploy: CFG, now: T + 1 });
  assert.equal(again.length, 0, 'once only');
});

test('on the first run a merge already live is marked silently, and one still waiting is told', () => {
  const items = [merged('a', T - 2 * 3600_000), merged('b', T - 2 * 3600_000)];
  const out = liveNotices({ items, inBuild: new Set(['sha-a']), liveSha: 'live123', entries: run(T - 3600_000), autoDeploy: CFG, firstRun: true, now: T });
  const a = out.find((n) => n.id === 'a');
  const b = out.find((n) => n.id === 'b');
  assert.ok(a.mr.live);
  assert.equal(a.text, null);
  assert.match(b.text, /^Merged but not live yet/);
  const later = liveNotices({ items: [{ ...items[1], mergeRequest: b.mr }], inBuild: new Set(['sha-b']), liveSha: 'live456', entries: [], autoDeploy: CFG, now: T + 1 });
  assert.match(later[0].text, /^Live: /, 'a merge stranded before the notices began still posts when it goes live');
});

test('a deploy that finished without the merge posts once why it is waiting: red main names its card, else the full run', () => {
  const items = [withPr(merged('a', T - 3600_000), 7)];
  const entries = run(T - 1800_000);
  const red = { [KEY]: { red: { sha: 'r', cardId: 'glmps-9' } } };
  const r1 = liveNotices({ items, inBuild: new Set(), liveSha: 'live123', entries, mainSuite: red, autoDeploy: CFG, now: T });
  assert.equal(r1.length, 1);
  assert.match(r1[0].text, /^Merged but not live yet: wolfeb-dev\/glmps#7 \(merge sha-a\) is not in the running build live123: main's full test run is red \(card glmps-9\)/);
  assert.ok(r1[0].mr.waitNotice);
  assert.equal(r1[0].mr.live, undefined);
  const r2 = liveNotices({ items, inBuild: new Set(), liveSha: 'live123', entries, mainSuite: {}, autoDeploy: CFG, now: T });
  assert.match(r2[0].text, /waiting for main's full test run to pass; it deploys on its own when it does/);
  const quiet = liveNotices({ items: [{ ...items[0], mergeRequest: r1[0].mr }], inBuild: new Set(), liveSha: 'live123', entries, autoDeploy: CFG, now: T + 1 });
  assert.equal(quiet.length, 0, 'the waiting post is made once');
  assert.equal(liveNotices({ items, inBuild: new Set(), liveSha: 'live123', entries: run(T - 2 * 3600_000), autoDeploy: CFG, now: T }).length, 0, 'no post before a deploy has run after the merge');
});

// Card glmps-2-0-176 (review finding 3): the live mark comes from the ancestry
// check of the merge commit itself, so a newer merge request on the same card
// is not marked live from the older one's check.
test('inBuild is keyed by merge commit: a newer merge on the same card is not marked live from the older check', () => {
  const card = withPr(merged('a', T - 1000), 7);
  const newer = { ...card, mergeRequest: { ...card.mergeRequest, number: 8, mergeSha: 'sha-a2' } };
  const out = liveNotices({ items: [newer], inBuild: new Set(['sha-a']), liveSha: 'live123', entries: [], autoDeploy: CFG, now: T });
  assert.equal(out.length, 0);
  assert.equal(liveNotices({ items: [newer], inBuild: new Set(['a']), liveSha: 'live123', entries: [], autoDeploy: CFG, now: T }).length, 0, 'a card id is not a merge commit');
});

// Card glmps-2-0-176 (review finding 2): ancestry against the kernel's commit
// says nothing about another repo, so there a finished deploy is the proof.
const OTHER_KEY = 'wolfeb-dev/widgets@main';
const BOTH = { ...CFG, [OTHER_KEY]: 'deploy-glmps2' };
const otherMerge = (id, at) => withPr(merged(id, at, { repo: 'wolfeb-dev/widgets', base: 'main' }), 3);

test('a merge into a repo the live server does not run is live once a deploy finished after it', () => {
  const items = [otherMerge('w', T - 3600_000)];
  const kernelRepo = 'wolfeb-dev/glmps';
  assert.equal(liveNotices({ items, liveSha: 'live123', entries: run(T - 2 * 3600_000), autoDeploy: BOTH, kernelRepo, now: T }).length, 0, 'no deploy after the merge yet: nothing');
  const out = liveNotices({ items, liveSha: 'live123', entries: run(T - 1800_000), autoDeploy: BOTH, kernelRepo, now: T, tz: 'America/Los_Angeles' });
  assert.equal(out.length, 1);
  assert.equal(out[0].mr.live.via, 'deploy');
  assert.equal(out[0].mr.live.sha, null);
  assert.match(out[0].text, /^Live: wolfeb-dev\/widgets#3 \(merge sha-w\) was deployed by a run that finished after the merge, as of .+ PT\.$/);
  assert.equal(out[0].mr.waitNotice, undefined, 'never told it waits for the kernel build');
  const quiet = liveNotices({ items, liveSha: 'live123', entries: run(T - 1800_000), autoDeploy: BOTH, kernelRepo, firstRun: true, now: T });
  assert.equal(quiet[0].text, null, 'the first run marks it silently');
});

test('a merge the live checkout cannot find is marked once as unverifiable and leaves the candidates', () => {
  const items = [withPr(merged('a', T - 1000), 7)];
  const out = liveNotices({ items, unverifiable: new Set(['sha-a']), liveSha: 'live123', entries: [], autoDeploy: CFG, now: T });
  assert.equal(out.length, 1);
  assert.ok(out[0].mr.liveUnknown);
  assert.equal(out[0].mr.live, undefined);
  assert.match(out[0].text, /^Cannot check live: wolfeb-dev\/glmps#7 \(merge sha-a\) is not in the live checkout, even after a fetch, so it is not checked again\.$/);
  assert.equal(liveCandidates({ items: [{ ...items[0], mergeRequest: out[0].mr }], autoDeploy: CFG, now: T }).length, 0);
});

test('mergeIsLive: no deploy configured, marked live, or unverifiable with a deploy finished after the merge', () => {
  const plain = merged('a', T - 3600_000).mergeRequest;
  assert.equal(mergeIsLive(plain, { entries: [], autoDeploy: {} }), true, 'nothing to deploy is live');
  assert.equal(mergeIsLive(plain, { entries: run(T - 1800_000), autoDeploy: CFG }), false, 'a finished deploy alone does not prove the kernel build has it');
  assert.equal(mergeIsLive({ ...plain, live: { sha: 'x', ts: T } }, { entries: [], autoDeploy: CFG }), true);
  const unknown = { ...plain, liveUnknown: { ts: T } };
  assert.equal(mergeIsLive(unknown, { entries: [], autoDeploy: CFG }), false);
  assert.equal(mergeIsLive(unknown, { entries: run(T - 1800_000), autoDeploy: CFG }), true);
});
