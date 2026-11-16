// Card glmps-2-0-73: GitHub Actions billed minutes from job start/end times,
// the allowance alert, and the once-a-month Slack post. Fixtures only; gh is a
// fake seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  osOf, jobMinutes, monthOf, summarize, actionsMinutesFindings, refreshActionsMinutes,
  pendingPosts, readActionsMinutes, writeActionsMinutesDoc, GH_JQ,
} from '../lib/observability/actions-minutes.js';
import { collectAlerts } from '../lib/observability/alert-sources.js';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const job = (labels, startIso, mins, steps = 3) => ({
  labels, started_at: startIso, completed_at: new Date(Date.parse(startIso) + mins * 60000).toISOString(), steps,
});

test('osOf and jobMinutes: label match, rounded up, refused jobs bill 0', () => {
  assert.equal(osOf(['windows-latest']), 'windows');
  assert.equal(osOf(['ubuntu-24.04']), 'ubuntu');
  assert.equal(osOf(['macos-15']), 'macos');
  assert.equal(osOf(['self-hosted']), 'other');
  assert.deepEqual(jobMinutes(job(['ubuntu-latest'], '2026-10-02T00:00:00Z', 2.1)), { os: 'ubuntu', ran: true, minutes: 3 });
  assert.deepEqual(jobMinutes(job(['windows-latest'], '2026-10-02T00:00:00Z', 5, 0)), { os: 'windows', ran: false, minutes: 0 });
  assert.deepEqual(jobMinutes({ labels: ['ubuntu-latest'], steps: 2, started_at: null }), { os: 'ubuntu', ran: true, minutes: 0 });
  assert.equal(monthOf(NOW), '2026-10');
});

const DOC = {
  month: '2026-10', updatedTs: NOW,
  runs: {
    'o/a#1': { repo: 'o/a', createdAt: '2026-10-02T00:00:00Z', status: 'completed',
      jobs: [{ os: 'ubuntu', ran: true, minutes: 3 }, { os: 'windows', ran: true, minutes: 8 }] },
    'o/b#2': { repo: 'o/b', createdAt: '2026-10-03T00:00:00Z', status: 'completed', jobs: [{ os: 'macos', ran: true, minutes: 2 }] },
  },
};

test('summarize: per repo and OS, weighted Windows x2 and macOS x10, against the allowance', () => {
  const s = summarize(DOC, { allowance: 100, now: NOW });
  assert.equal(s.billed, 3 + 16 + 20);
  assert.equal(s.usedPercent, 39);
  assert.equal(s.remaining, 61);
  assert.deepEqual(s.byOs.windows, { minutes: 8, billed: 16, multiplier: 2 });
  assert.deepEqual(s.byOs.macos, { minutes: 2, billed: 20, multiplier: 10 });
  assert.deepEqual(s.byRepo.map((r) => [r.repo, r.billed]), [['o/b', 20], ['o/a', 19]]);
  assert.deepEqual(s.byRepo.find((r) => r.repo === 'o/a').os.windows, { minutes: 8, billed: 16 });
  assert.equal(s.refusedSince, null);
});

test('summarize: refusedSince is the first refused job after the last one that ran', () => {
  const doc = structuredClone(DOC);
  doc.runs['o/a#3'] = { repo: 'o/a', createdAt: '2026-10-20T03:05:00Z', status: 'completed', jobs: [{ os: 'ubuntu', ran: false, minutes: 0 }] };
  doc.runs['o/a#4'] = { repo: 'o/a', createdAt: '2026-10-20T04:00:00Z', status: 'completed', jobs: [{ os: 'ubuntu', ran: false, minutes: 0 }] };
  assert.equal(summarize(doc).refusedSince, '2026-10-20T03:05:00Z');
  doc.runs['o/a#5'] = { repo: 'o/a', createdAt: '2026-10-20T05:00:00Z', status: 'completed', jobs: [{ os: 'ubuntu', ran: true, minutes: 1 }] };
  assert.equal(summarize(doc).refusedSince, null, 'jobs running again ends the episode');
});

test('actionsMinutesFindings: highest crossed threshold only, top one critical, refused is its own finding', () => {
  const at = (usedPercent, extra = {}) => ({ month: '2026-10', usedPercent, billed: usedPercent * 20, allowance: 2000, refusedSince: null, ...extra });
  assert.deepEqual(actionsMinutesFindings(at(74.9)), []);
  const warn = actionsMinutesFindings(at(80));
  assert.equal(warn.length, 1);
  assert.equal(warn[0].threshold, 75);
  assert.equal(warn[0].critical, false);
  const crit = actionsMinutesFindings(at(91));
  assert.equal(crit[0].threshold, 90);
  assert.equal(crit[0].critical, true);
  const refused = actionsMinutesFindings(at(116, { refusedSince: '2026-10-20T03:05:48Z' }));
  assert.deepEqual(refused.map((f) => f.kind), ['threshold', 'refused']);
  assert.deepEqual(actionsMinutesFindings(at(60), { thresholds: [50] }).map((f) => f.threshold), [50]);
  assert.deepEqual(actionsMinutesFindings(null), []);
});

function fakeGh(byPath) {
  const calls = [];
  const gh = async (file, args) => {
    calls.push(args[2]);
    const hit = Object.entries(byPath).find(([p]) => args[2].startsWith(p));
    if (!hit) return { status: 1, stderr: `no fixture for ${args[2]}` };
    return { status: 0, stdout: hit[1].map((x) => JSON.stringify(x)).join('\n') + '\n' };
  };
  return { gh, calls };
}

test('refreshActionsMinutes: fetches the month, caches completed runs, records per-repo errors', async () => {
  const { gh, calls } = fakeGh({
    'repos/o/a/actions/runs?': [{ id: 1, created_at: '2026-10-02T00:00:00Z', status: 'completed' }, { id: 2, created_at: '2026-10-19T00:00:00Z', status: 'in_progress' }],
    'repos/o/a/actions/runs/1/jobs': [job(['ubuntu-latest'], '2026-10-02T00:00:00Z', 2), job(['windows-latest'], '2026-10-02T00:00:00Z', 7)],
    'repos/o/a/actions/runs/2/jobs': [job(['ubuntu-latest'], '2026-10-19T00:00:00Z', 1)],
  });
  const doc = await refreshActionsMinutes({ repos: ['o/a', 'o/missing'], gh, now: NOW });
  assert.ok(calls[0].includes('created=%3E%3D2026-10-01'), 'asks for the current month only');
  assert.ok(calls.some((c) => c.includes('/jobs?per_page=100&filter=all')), 're-run attempts count');
  assert.equal(doc.month, '2026-10');
  assert.equal(Object.keys(doc.runs).length, 2);
  assert.deepEqual(doc.errors.map((e) => e.repo), ['o/missing']);
  assert.equal(summarize(doc).billed, 2 + 14 + 1);

  const again = fakeGh({
    'repos/o/a/actions/runs?': [{ id: 1, created_at: '2026-10-02T00:00:00Z', status: 'completed' }, { id: 2, created_at: '2026-10-19T00:00:00Z', status: 'completed' }],
    'repos/o/a/actions/runs/2/jobs': [job(['ubuntu-latest'], '2026-10-19T00:00:00Z', 4)],
  });
  const next = await refreshActionsMinutes({ prev: doc, repos: ['o/a'], gh: again.gh, now: NOW });
  assert.ok(!again.calls.some((c) => c.includes('/runs/1/jobs')), 'a completed run is never refetched');
  assert.equal(summarize(next).billed, 2 + 14 + 4, 'an in-progress run is refetched until it completes');

  const rolled = await refreshActionsMinutes({ prev: { ...next, posted: ['threshold:75'] }, repos: [], gh: again.gh, now: Date.parse('2026-11-01T00:30:00Z') });
  assert.equal(rolled.month, '2026-11');
  assert.deepEqual(rolled.runs, {});
  assert.deepEqual(rolled.posted, [], 'a new month posts again');
});

test('pendingPosts: one post per threshold per month and per refused episode', () => {
  const findings = actionsMinutesFindings({ month: '2026-10', usedPercent: 92, billed: 1840, allowance: 2000, refusedSince: '2026-10-20T03:05:48Z' });
  const first = pendingPosts({ posted: [] }, findings);
  assert.deepEqual(first.map((p) => p.key), ['threshold:90', 'refused:2026-10-20T03:05:48Z']);
  assert.match(first[0].text, /92% of the 2000-minute monthly allowance/);
  assert.deepEqual(pendingPosts({ posted: first.map((p) => p.key) }, findings), []);
});

test('readActionsMinutes: missing or last-month file answers an empty current month', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-actmin-'));
  try {
    assert.equal(readActionsMinutes(dir, { now: NOW }).billed, 0);
    writeActionsMinutesDoc(dir, { ...DOC, month: '2026-09' });
    const r = readActionsMinutes(dir, { now: NOW, allowance: 2000 });
    assert.equal(r.month, '2026-10');
    assert.equal(r.billed, 0);
    writeActionsMinutesDoc(dir, DOC);
    assert.equal(readActionsMinutes(dir, { now: NOW, allowance: 2000 }).billed, 39);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('collectAlerts: actions-minutes findings reach the alert center with an episode target', () => {
  const findings = actionsMinutesFindings({ month: '2026-10', usedPercent: 80, billed: 1600, allowance: 2000, refusedSince: '2026-10-20T03:05:48Z' });
  const alerts = collectAlerts({ actionsMinutes: findings }).filter((a) => a.source === 'actions-minutes');
  assert.equal(alerts.length, 2);
  const th = alerts.find((a) => /allowance/.test(a.title));
  assert.equal(th.severity, 'warn');
  assert.match(th.title, /75%/);
  assert.match(th.detail, /1600 of 2000/);
  const rf = alerts.find((a) => /refusing/.test(a.title));
  assert.equal(rf.severity, 'critical');
});

test('server: the actions-minutes loop fills the routes and the alert center through the gh seam', async () => {
  const { startServer } = await import('../server.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-actmin-route-'));
  const stateDir = path.join(base, 'state'); fs.mkdirSync(stateDir);
  const claudeDir = path.join(base, 'claude'); fs.mkdirSync(claudeDir);
  const configFile = path.join(base, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ actionsMinutes: { repos: ['o/a'], allowance: 20 } }));
  const created = new Date().toISOString();
  const { gh } = fakeGh({
    'repos/o/a/actions/runs?': [{ id: 7, created_at: created, status: 'completed' }],
    'repos/o/a/actions/runs/7/jobs': [job(['windows-latest'], created, 8)],
  });
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off' };
  const h = await startServer({ port: 0, env, configFile, ghRun: gh });
  try {
    const run = await h.loopRegistry.runNow('actions-minutes', {});
    assert.equal(run.outcome, 'done', JSON.stringify(run));
    const j = await (await fetch(`http://127.0.0.1:${h.port}/api/usage/actions`)).json();
    assert.equal(j.billed, 16);
    assert.equal(j.usedPercent, 80);
    assert.deepEqual(j.thresholds, [75, 90], 'the panel meter colours by the same thresholds as the alert');
    assert.deepEqual(j.byRepo[0].os.windows, { minutes: 8, billed: 16 });
    const alerts = await (await fetch(`http://127.0.0.1:${h.port}/api/alerts`)).json();
    const list = Array.isArray(alerts) ? alerts : (alerts.alerts ?? alerts.items ?? []);
    assert.ok(list.some((a) => a.source === 'actions-minutes' && /75%/.test(a.title)), JSON.stringify(list.map((a) => a.title)));
    const doc = JSON.parse(fs.readFileSync(path.join(stateDir, 'cache', 'actions-minutes.json'), 'utf-8'));
    assert.deepEqual(doc.posted, ['threshold:75'], 'the crossing is posted once and remembered');
    await h.loopRegistry.runNow('actions-minutes', {});
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, 'cache', 'actions-minutes.json'), 'utf-8')).posted, ['threshold:75']);
  } finally {
    await h.close?.();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Card glmps-2-0-runtime-132: CI runs nightly, so a red scheduled run is the
// signal nobody else watches.
const nightlyRun = (id, created, conclusion, name = 'CI', event = 'schedule') => ({ id, created_at: created, status: 'completed', event, conclusion, name, head_branch: 'glmps2/main' });

test('nightly: the newest scheduled run per repo and workflow decides, a later green clears it', async () => {
  const { gh } = fakeGh({
    'repos/o/a/actions/runs?': [
      nightlyRun(11, '2026-10-18T09:00:00Z', 'success'),
      nightlyRun(12, '2026-10-19T09:00:00Z', 'failure'),
      nightlyRun(13, '2026-10-19T09:05:00Z', 'success', 'Tap'),
      nightlyRun(14, '2026-10-19T10:00:00Z', 'failure', 'CI', 'workflow_dispatch'),
    ],
    'repos/o/a/actions/runs/1': [job(['ubuntu-latest'], '2026-10-18T09:00:00Z', 1)],
  });
  const doc = await refreshActionsMinutes({ repos: ['o/a'], gh, now: NOW });
  assert.deepEqual(doc.runs['o/a#12'], { ...doc.runs['o/a#12'], event: 'schedule', conclusion: 'failure', workflow: 'CI', branch: 'glmps2/main' });
  const s = summarize(doc);
  assert.deepEqual(s.nightly.map((n) => [n.workflow, n.runId, n.conclusion]), [['CI', '12', 'failure'], ['Tap', '13', 'success']]);
  const red = actionsMinutesFindings(s).filter((f) => f.kind === 'nightly-red');
  assert.deepEqual(red.map((f) => [f.repo, f.workflow, f.runId]), [['o/a', 'CI', '12']], 'an on-demand run does not count as nightly');

  const posts = pendingPosts({ posted: [] }, red);
  assert.deepEqual(posts.map((p) => p.key), ['nightly-red:o/a#12']);
  assert.match(posts[0].text, /Nightly CI run on o\/a \(glmps2\/main\) ended failure: https:\/\/github.com\/o\/a\/actions\/runs\/12/);
  assert.deepEqual(pendingPosts({ posted: ['nightly-red:o/a#12'] }, red), [], 'posted once per run');

  const alerts = collectAlerts({ actionsMinutes: red }).filter((a) => a.source === 'actions-minutes');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'warn');
  assert.match(alerts[0].title, /Nightly CI run is red on o\/a/);
  assert.deepEqual(alerts[0].target, { view: 'analytics', repo: 'o/a', workflow: 'CI', runId: '12' });

  const green = await refreshActionsMinutes({ prev: doc, repos: ['o/a'], gh: fakeGh({
    'repos/o/a/actions/runs?': [nightlyRun(12, '2026-10-19T09:00:00Z', 'failure'), nightlyRun(15, '2026-10-20T09:00:00Z', 'success')],
    'repos/o/a/actions/runs/15': [],
  }).gh, now: NOW });
  assert.deepEqual(actionsMinutesFindings(summarize(green)).filter((f) => f.kind === 'nightly-red'), []);
});

test('nightly: an older desktop shell that refuses the wider filter still counts minutes', async () => {
  const seen = [];
  const gh = async (file, args) => {
    seen.push(args[4]);
    if (args[2].includes('/jobs')) return { status: 0, stdout: JSON.stringify(job(['ubuntu-latest'], '2026-10-19T09:00:00Z', 3)) + '\n' };
    if (args[4] !== '.workflow_runs[] | {id, created_at, status}') return { status: 1, stderr: 'gh api actions runs: unexpected --jq filter' };
    return { status: 0, stdout: JSON.stringify({ id: 21, created_at: '2026-10-19T09:00:00Z', status: 'completed' }) + '\n' };
  };
  const doc = await refreshActionsMinutes({ repos: ['o/a'], gh, now: NOW });
  assert.deepEqual(doc.errors, []);
  assert.equal(summarize(doc).billed, 3);
  assert.deepEqual(summarize(doc).nightly, []);
  assert.equal(seen.filter((f) => /workflow_runs/.test(f)).length, 2, 'wide filter tried first, then the legacy one');

  // Once the shell allows it, the cached run gains its result without a jobs refetch.
  const { gh: wide, calls } = fakeGh({ 'repos/o/a/actions/runs?': [nightlyRun(21, '2026-10-19T09:00:00Z', 'timed_out')] });
  const next = await refreshActionsMinutes({ prev: doc, repos: ['o/a'], gh: wide, now: NOW });
  assert.ok(!calls.some((c) => c.includes('/jobs')));
  assert.equal(summarize(next).billed, 3);
  assert.deepEqual(actionsMinutesFindings(summarize(next)).map((f) => f.kind), ['nightly-red']);
});

// Card glmps-2-0-runtime-133, review finding 2: a fallback to the legacy filter
// leaves nightly results unseen, so it must say so instead of going quiet.
test('nightly: a fallback to the legacy filter raises a nightly-blind alert with the original error, cleared once the wide filter works', async () => {
  const gh = async (file, args) => {
    if (args[2].includes('/jobs')) return { status: 0, stdout: JSON.stringify(job(['ubuntu-latest'], '2026-10-19T09:00:00Z', 3)) + '\n' };
    if (args[4] !== GH_JQ.runsLegacy) return { status: 1, stderr: 'gh api actions runs: unexpected --jq filter' };
    return { status: 0, stdout: JSON.stringify({ id: 21, created_at: '2026-10-19T09:00:00Z', status: 'completed' }) + '\n' };
  };
  const doc = await refreshActionsMinutes({ repos: ['o/a'], gh, now: NOW });
  assert.deepEqual(doc.nightlyBlind, [{ repo: 'o/a', error: 'gh api actions runs: unexpected --jq filter' }]);
  const blind = actionsMinutesFindings(summarize(doc)).filter((f) => f.kind === 'nightly-blind');
  assert.equal(blind.length, 1);
  assert.deepEqual(pendingPosts({ posted: [] }, blind), [], 'alert only: a transient gh failure lands here too');
  const alerts = collectAlerts({ actionsMinutes: blind }).filter((a) => a.source === 'actions-minutes');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /Nightly CI results are not being read/);
  assert.match(alerts[0].detail, /o\/a/);
  assert.match(alerts[0].detail, /unexpected --jq filter/);

  const { gh: wide } = fakeGh({ 'repos/o/a/actions/runs?': [nightlyRun(21, '2026-10-19T09:00:00Z', 'success')] });
  const next = await refreshActionsMinutes({ prev: doc, repos: ['o/a'], gh: wide, now: NOW });
  assert.deepEqual(next.nightlyBlind, []);
  assert.deepEqual(actionsMinutesFindings(summarize(next)), []);
});

// Review finding 4: the run listing is per month, so a red nightly run from the
// last day of a month must survive the month change until a newer run replaces it.
test('nightly: a red run from last month stays alerted across the month change, is not posted again, and a later green clears it', async () => {
  const { gh } = fakeGh({ 'repos/o/a/actions/runs?': [nightlyRun(31, '2026-10-31T10:17:00Z', 'failure')], 'repos/o/a/actions/runs/31': [] });
  const oct = await refreshActionsMinutes({ repos: ['o/a'], gh, now: Date.parse('2026-10-31T12:00:00Z') });
  const octPosted = { ...oct, posted: ['threshold:75', 'nightly-red:o/a#31'] };

  const nov1 = Date.parse('2026-11-01T01:00:00Z');
  const rolled = await refreshActionsMinutes({ prev: octPosted, repos: ['o/a'], gh: fakeGh({ 'repos/o/a/actions/runs?': [] }).gh, now: nov1 });
  assert.equal(rolled.month, '2026-11');
  assert.deepEqual(rolled.runs, {});
  const red = actionsMinutesFindings(summarize(rolled, { now: nov1 })).filter((f) => f.kind === 'nightly-red');
  assert.deepEqual(red.map((f) => f.runId), ['31'], 'still red after the month change');
  assert.deepEqual(rolled.posted, ['nightly-red:o/a#31'], 'thresholds reset, the carried red run is not posted twice');
  assert.deepEqual(pendingPosts(rolled, red), []);
  assert.equal(summarize(rolled, { now: nov1 }).billed, 0, 'a carried result bills nothing');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-actmin-carry-'));
  try {
    writeActionsMinutesDoc(dir, octPosted);
    const read = readActionsMinutes(dir, { now: nov1 });
    assert.deepEqual(actionsMinutesFindings(read).filter((f) => f.kind === 'nightly-red').map((f) => f.runId), ['31'], 'before the first November refresh too');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  const again = await refreshActionsMinutes({ prev: rolled, repos: ['o/a'], gh: fakeGh({ 'repos/o/a/actions/runs?': [] }).gh, now: nov1 + 3600_000 });
  assert.deepEqual(actionsMinutesFindings(summarize(again)).filter((f) => f.kind === 'nightly-red').map((f) => f.runId), ['31'], 'carried within the month');

  const green = await refreshActionsMinutes({ prev: again, repos: ['o/a'], gh: fakeGh({
    'repos/o/a/actions/runs?': [nightlyRun(32, '2026-11-01T10:17:00Z', 'success')], 'repos/o/a/actions/runs/32': [],
  }).gh, now: Date.parse('2026-11-01T12:00:00Z') });
  assert.deepEqual(actionsMinutesFindings(summarize(green)).filter((f) => f.kind === 'nightly-red'), []);
});

// Card glmps-2-0-runtime-138, finding 4: a carried result whose workflow had no
// scheduled run for a whole month (deleted, renamed, unscheduled) stops riding.
test('nightly: a carried red result with no scheduled run for a whole month is dropped at the next month change', async () => {
  const none = fakeGh({ 'repos/o/a/actions/runs?': [] }).gh;
  const { gh } = fakeGh({ 'repos/o/a/actions/runs?': [nightlyRun(31, '2026-10-31T10:17:00Z', 'failure')], 'repos/o/a/actions/runs/31': [] });
  const oct = await refreshActionsMinutes({ repos: ['o/a'], gh, now: Date.parse('2026-10-31T12:00:00Z') });
  const nov = await refreshActionsMinutes({ prev: { ...oct, posted: ['nightly-red:o/a#31'] }, repos: ['o/a'], gh: none, now: Date.parse('2026-11-15T12:00:00Z') });
  assert.deepEqual(nov.nightlyCarry.map((n) => n.runId), ['31'], 'carried for the month after the run');
  const dec1 = Date.parse('2026-12-01T01:00:00Z');
  const dec = await refreshActionsMinutes({ prev: nov, repos: ['o/a'], gh: none, now: dec1 });
  assert.deepEqual(dec.nightlyCarry, []);
  assert.deepEqual(dec.posted, []);
  assert.deepEqual(actionsMinutesFindings(summarize(dec, { now: dec1 })), []);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-actmin-expire-'));
  try {
    writeActionsMinutesDoc(dir, nov);
    assert.deepEqual(actionsMinutesFindings(readActionsMinutes(dir, { now: dec1 })), [], 'the read path drops it too');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Card glmps-2-0-runtime-138, finding 5: the read between the month change and
// the first refresh of the new month keeps a standing blind alert.
test('nightly: a nightly-blind alert survives the month-change read until the next refresh', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-actmin-blind-'));
  try {
    writeActionsMinutesDoc(dir, { month: '2026-10', runs: {}, nightlyBlind: [{ repo: 'o/a', error: 'refused' }], updatedTs: 1 });
    const read = readActionsMinutes(dir, { now: Date.parse('2026-11-01T01:00:00Z') });
    assert.deepEqual(actionsMinutesFindings(read).filter((f) => f.kind === 'nightly-blind').map((f) => f.repos), [[{ repo: 'o/a', error: 'refused' }]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
