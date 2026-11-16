import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wikiFrameSrc } from '../../web/observability/wiki.js';
import {
  groupSections, firstWikiSlug, shouldFallBackToDefault, emptyStateCopy, wikiMetaLine, effectiveTheme,
} from '../../web/observability/wiki-nav-model.js';

test('wikiFrameSrc appends the theme after the ticket and the cache-bust', () => {
  assert.equal(wikiFrameSrc('/wiki', 'a', '?v=1', 'T.x', 'light'), '/wiki/a.html?v=1&wiki_ticket=T.x&theme=light');
  assert.equal(wikiFrameSrc('/wiki', 'a', '', '', 'dark'), '/wiki/a.html?theme=dark');
  assert.equal(wikiFrameSrc('/wiki', 'a', '', '', null), '/wiki/a.html');
});

test('effectiveTheme: the pinned theme wins, else the OS preference', () => {
  const doc = (theme) => ({ documentElement: { dataset: theme ? { theme } : {} } });
  const mm = (light) => () => ({ matches: light });
  assert.equal(effectiveTheme(doc('dark'), mm(true)), 'dark');
  assert.equal(effectiveTheme(doc('light'), mm(false)), 'light');
  assert.equal(effectiveTheme(doc(null), mm(true)), 'light');
  assert.equal(effectiveTheme(doc(null), mm(false)), 'dark');
  assert.equal(effectiveTheme(null, mm(true)), null);
});

test('groupSections: three groups in order, Documentation split by subgroup, sorted by order then title', () => {
  const s = [
    { slug: 'c1', title: 'Kernel', group: 'concepts', order: 1 },
    { slug: 'k1', title: 'Server', group: 'code', order: 1 },
    { slug: 'a2', title: 'Admin B', group: 'documentation', subgroup: 'Admin guide', order: 2 },
    { slug: 'u2', title: 'Beta', group: 'documentation', subgroup: 'User guide', order: 2 },
    { slug: 'u1', title: 'Zed', group: 'documentation', subgroup: 'User guide', order: 1 },
    { slug: 'u3', title: 'Alpha', group: 'documentation', subgroup: 'User guide', order: 2 },
  ];
  const g = groupSections(s);
  assert.deepEqual(g.map((x) => x.key), ['documentation', 'concepts', 'code']);
  const doc = g[0].parts;
  assert.deepEqual(doc.map((p) => p.label), ['User guide', 'Admin guide']);
  assert.deepEqual(doc[0].items.map((x) => x.slug), ['u1', 'u3', 'u2']);
});

test('groupSections: an old build with no groups stays flat; ungrouped items land in Other', () => {
  assert.equal(groupSections([{ slug: 'a' }, { slug: 'b' }]), null);
  assert.equal(groupSections([]), null);
  const g = groupSections([{ slug: 'a', group: 'code' }, { slug: 'b' }]);
  assert.deepEqual(g.map((x) => x.key), ['code', 'other']);
});

test('firstWikiSlug: first Documentation page, else the first section', () => {
  assert.equal(firstWikiSlug([{ slug: 'k', group: 'code' }, { slug: 'd2', group: 'documentation', order: 2 }, { slug: 'd1', group: 'documentation', order: 1 }]), 'd1');
  assert.equal(firstWikiSlug([{ slug: 'x' }, { slug: 'y' }]), 'x');
  assert.equal(firstWikiSlug([]), null);
});

test('shouldFallBackToDefault: only for an auto-picked project with no manifest', () => {
  const none = { manifest: null };
  const built = { manifest: { generatedAt: 1 } };
  assert.equal(shouldFallBackToDefault({ chosen: false, requested: 'D:\\p', data: none }), true);
  assert.equal(shouldFallBackToDefault({ chosen: false, requested: 'D:\\p', data: built }), false);
  assert.equal(shouldFallBackToDefault({ chosen: true, requested: 'D:\\p', data: none }), false, 'an explicit choice is respected');
  assert.equal(shouldFallBackToDefault({ chosen: false, requested: null, data: none }), false, 'no loop on the server default');
});

test('emptyStateCopy: runtime says when the next build is, other projects say there is no wiki', () => {
  const now = 1_000_000_000;
  const rt = emptyStateCopy({ loop: { nextRunTs: now + 12 * 60000, lastOutcome: 'built' } }, now);
  assert.equal(rt.title, 'The wiki has not been built yet');
  assert.deepEqual(rt.lines, ['Next automatic build: in 12m']);
  const failed = emptyStateCopy({ loop: { nextRunTs: now + 3 * 3600000, lastOutcome: 'failed', lastReason: 'checker rejected 3 pages' } }, now);
  assert.equal(failed.lines[0], 'Last build failed: checker rejected 3 pages');
  assert.equal(failed.lines[1], 'Next automatic build: in 3h');
  const other = emptyStateCopy({ loop: null }, now);
  assert.equal(other.title, 'This project has no wiki');
  assert.deepEqual(other.lines, ['Automatic builds cover the GLMPS runtime only. Generate builds one now.']);
  for (const c of [rt, failed, other]) assert.doesNotMatch(JSON.stringify(c), /[\u2013\u2014]/);
});

test('wikiMetaLine: page count, relative build time and short sha', () => {
  const now = Date.UTC(2026, 9, 23, 12);
  const data = { manifest: { generatedAt: now - 2 * 3600000, builtAtCommit: 'c79872a1234567' } };
  assert.equal(wikiMetaLine(data, 27, now), '27 pages, built 2h ago at c79872a');
  assert.equal(wikiMetaLine({ manifest: {} }, 1, now), '1 page');
});
