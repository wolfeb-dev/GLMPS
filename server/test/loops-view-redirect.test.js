// K3's static scan against web/app.js's now-deleted VIEW_REDIRECTS/NAV_VIEWS
// no longer applies (D-surface Task 4 removes both): a loop alert's target
// is resolved through resolveTarget() instead. Since card glmps-2-0-137 Loops is
// an Evolution tab: the alert target and the old /loops, /personality and
// /wiki/ paths land on the matching Evolution or Knowledge tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget, parseLink, linkFor } from '../../web/shared/deep-link.js';

const canonical = (p, q = '') => linkFor(parseLink(p, q));

test('the loops alert target resolves onto the Evolution Loops tab, loop selected', () => {
  assert.equal(resolveTarget({ view: 'loops', loop: 'wiki' }), '/learning?tab=loops&sel=loop%3Awiki');
});

test('old /loops, /personality and /wiki/ bookmarks land on the matching tab', () => {
  assert.equal(canonical('/loops'), '/learning?tab=loops');
  assert.equal(canonical('/loops', '?sel=loop%3Alaunch-queue'), '/learning?tab=loops&sel=loop%3Alaunch-queue');
  assert.equal(canonical('/personality'), '/learning?tab=capabilities&seg=files');
  assert.equal(canonical('/personality', '?sel=card%3Aprompt'), '/learning?tab=capabilities&seg=files&sel=card%3Aprompt');
  assert.equal(canonical('/wiki/'), '/knowledge?tab=wiki');
});
