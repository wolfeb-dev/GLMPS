// The session page as mounted: one header and three bands in the state's
// order, a back label naming the lens, no Unused assets, one paged feed
// (card glmps-2-0-runtime-60, session-detail spec section 8 item 7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const NOW = Date.now();

function ev(i, extra = {}) {
  return { kind: 'command', lane: 'feed', tool: 'Bash', label: `cmd ${i}`, ts: NOW - (100 - i) * 1000, sessionId: 'S', ...extra };
}

function detailFixture({ card = null, total = 60, events = null } = {}) {
  const evs = events ?? Array.from({ length: 50 }, (_, i) => ev(i + 10));
  return {
    events: evs,
    page: { total, returned: evs.length, limit: 50, before: null, hasMore: total > evs.length, nextBefore: evs[0]?.ts ?? null },
    contextNow: [], usage: { unused: { skills: [{ name: 'never-used' }] } },
    guiding: [{ name: 'CLAUDE.md', path: 'D:/r/CLAUDE.md', scope: 'project' }], skillsUsed: ['tdd'],
    gaps: [], loop: { stage: 2, key: 'execute', status: 'active', enteredTs: NOW - 60000 },
    scope: { zones: [{ zone: 'web', env: 'dev', count: 2 }] }, workspace: null,
    fitness: { tracked: 0, byKind: {} }, card, outcome: null,
    learning: { items: [], lessons: [], summary: {} }, refusals: { items: [], count: 0, refused: 0, failOpen: 0 },
    touch: { files: [{ path: 'D:/r/web/a.js', kind: 'file-edit', reads: 0, writes: 1, add: 4, del: 1, change: { old: 'a', new: 'b' }, lastTs: NOW }],
      commits: [{ subject: 'Add a', ts: NOW }], pushes: 0, span: { firstTs: NOW - 40 * 60000, lastTs: NOW }, counts: { written: 1, read: 0, commits: 1 } },
  };
}

async function mountPage({ summary, fixture, older, fromLens = 'Work' }) {
  const dom = installMiniDom({ pathname: '/session/S' });
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith('/api/approvals')) return Response.json({ requests: [{ ticketId: 'c-9', status: 'pending', action: 'deploy-glmps2' }] });
    if (u.includes('before=')) return Response.json(older ?? { events: [], page: { hasMore: false } });
    return Response.json(fixture);
  };
  const page = await import('../../web/shared/session-page.js');
  const root = document.createElement('div');
  document.body.appendChild(root);
  const ctx = {
    getState: () => ({ sessions: [summary] }), fromLensLabel: () => fromLens, toast() {}, go() {},
    handlers: { onOpenFile() {}, onCopy() {}, onOpenMap() {} }, isCurrent: () => true,
  };
  const handle = await page.mount(root, { lens: 'session', sessionId: 'S' }, ctx);
  await tick();
  return { dom, root, handle, calls, done: () => { handle.unmount(); delete globalThis.fetch; dom.restore(); } };
}

const bandIds = (root) => root.querySelectorAll('.session-band').map((s) => s.id);

test('a finished card session leads with Touching and names the lens it came from', async () => {
  const card = { id: 'c-9', title: 'Ship it', acceptanceCriteria: [{ text: 'AC-1', done: true }], gate: { status: 'PASS', risk: 'P3', evidenceCount: 1 },
    prUrl: 'https://github.com/o/r/pull/7', mergeQueue: { stage: 'reviewing', round: 1, number: 7 } };
  const p = await mountPage({ summary: { id: 'S', tool: 'claude-code', state: 'ended', status: { cost: { totalUsd: 2 } } }, fixture: detailFixture({ card }) });
  try {
    assert.deepEqual(bandIds(p.root), ['touching', 'learning', 'doing']);
    assert.equal(p.root.querySelector('.detail-back').textContent, '< Work');
    assert.equal(p.root.querySelector('.sp-card-id').textContent, 'c-9');
    assert.equal(p.root.querySelector('.detail-title').textContent, 'Ship it');
    assert.equal(p.root.querySelector('.sp-state').textContent, 'FINISHED');
    const slots = p.root.querySelectorAll('.verdict-label').map((n) => n.textContent);
    for (const s of ['GATE', 'JUDGE', 'DONE-GATE', 'PR', 'APPROVALS', 'SPEND', 'CTX LAST', 'WALL']) assert.ok(slots.includes(s), `${s} slot drawn`);
    assert.ok(!slots.includes('TOKENS'), 'no TOKENS slot while no summary carries a token total');
    assert.equal(p.root.querySelector('.verdict-approvals').querySelector('.verdict-word').textContent, '1 WAITING');
    assert.equal(p.root.querySelector('.sp-primary').textContent, 'Open PR');
    assert.match(p.root.querySelector('.sp-sentence').textContent, /^Finished .*Gate PASS, judge pending, PR #7 reviewing\./);
    assert.ok(!p.root.textContent.includes('Unused assets'), 'no Unused assets panel');
    assert.ok(!p.root.textContent.includes('never-used'));
    assert.ok(!p.root.textContent.includes('grid'), 'no "grid" label');
    assert.ok(p.calls.some((u) => u.includes('session=S') && u.includes('limit=50')), 'the feed is paged server-side');
  } finally { p.done(); }
});

test('a live session leads with Doing; the feed pages older and live rows append', async () => {
  const older = { events: Array.from({ length: 10 }, (_, i) => ev(i)), page: { hasMore: false, nextBefore: null } };
  const p = await mountPage({ summary: { id: 'S', tool: 'claude-code', state: 'working' }, fixture: detailFixture(), older, fromLens: null });
  try {
    assert.deepEqual(bandIds(p.root), ['doing', 'touching', 'learning']);
    assert.equal(p.root.querySelector('.detail-back').textContent, '< Back');
    assert.equal(p.root.querySelector('.sp-primary').textContent, 'Steer');
    const all = p.root.querySelectorAll('.sp-chip').find((b) => b.textContent === 'all');
    all.click();
    const feed = p.root.querySelector('.sp-feed');
    assert.equal(feed.querySelectorAll('.event-row').length, 50);
    assert.equal(feed.querySelectorAll('.event-row')[0].textContent.includes('cmd 59'), true, 'newest first');
    assert.equal(p.root.querySelector('.sp-feed-count').textContent, 'showing 50 of 60');
    p.root.querySelector('.sp-more').click();
    await tick();
    assert.ok(p.calls.some((u) => u.includes('before=')), 'older page asked with before');
    assert.equal(feed.querySelectorAll('.event-row').length, 60);
    // Paged away: a live row bumps the "N new" chip instead of moving the list.
    window.dispatchEvent(new CustomEvent('mc-events', { detail: { sessionId: 'S', events: [ev(200)] } }));
    assert.equal(p.root.querySelector('.sp-new-chip').textContent, '1 new');
    assert.equal(feed.querySelectorAll('.event-row').length, 60);
    p.root.querySelector('.sp-new-chip').click();
    assert.equal(feed.querySelectorAll('.event-row').length, 61);
  } finally { p.done(); }
});

test('an abandoned card session names the missing gate and offers Requeue', async () => {
  const card = { id: 'c-9', title: 'Half done', acceptanceCriteria: [], gate: null, prUrl: null, mergeQueue: null };
  const p = await mountPage({ summary: { id: 'S', tool: 'claude-code', state: 'ended' }, fixture: detailFixture({ card }) });
  try {
    assert.equal(p.root.querySelector('.sp-state').textContent, 'ABANDONED');
    assert.equal(p.root.querySelector('.verdict-gate').querySelector('.verdict-word').textContent, 'MISSING');
    assert.equal(p.root.querySelector('.sp-primary').textContent, 'Requeue card');
    assert.deepEqual(bandIds(p.root), ['doing', 'touching', 'learning']);
  } finally { p.done(); }
});

test('no log: header only with the reason, bands closed', async () => {
  const p = await mountPage({ summary: { id: 'S', tool: 'antigravity', state: 'ended', format: 'remote' }, fixture: { ...detailFixture({ total: 0, events: [] }), touch: null } });
  try {
    assert.equal(p.root.querySelector('.sp-state').textContent, 'NO LOG');
    assert.match(p.root.querySelector('.sp-sentence').textContent, /cloud backend/);
    assert.ok(p.root.querySelectorAll('.session-band-details').every((d) => d.open === false));
  } finally { p.done(); }
});

test('the Doing band says what is missing rather than drawing an empty list', async () => {
  const p = await mountPage({ summary: { id: 'S', tool: 'claude-code', state: 'idle' }, fixture: detailFixture({ total: 3, events: [ev(1)] }) });
  try {
    assert.equal(p.root.querySelector('.sp-state').textContent, 'IDLE');
    assert.equal(p.root.querySelector('.sp-primary').textContent, 'Resume');
    assert.match(p.root.querySelector('.sp-feed').querySelector('.band-empty').textContent, /^No context events in the 1 loaded/);
  } finally { p.done(); }
});

test('a band the page opens or closes does not overwrite the viewer\'s saved choice', async () => {
  const dom = installMiniDom({ pathname: '/session/S' });
  try {
    const B = await import('../../web/observability/session-bands.js');
    const band = B.buildBand('touching', 'Touching', '');
    assert.equal(band.det.open, true, 'open by default on desktop');
    B.setBandOpen(band, false);
    band.det.dispatchEvent(new Event('toggle'));
    assert.equal(B.readPref('open.touching'), undefined, 'a programmatic close is not saved');
    band.det.open = true;
    band.det.dispatchEvent(new Event('toggle'));
    assert.equal(B.readPref('open.touching'), true, 'the viewer\'s toggle is saved');
  } finally { dom.restore(); }
});
