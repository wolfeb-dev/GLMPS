import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseLink, linkFor, LEGACY_VIEWS } from '../../web/shared/deep-link.js';

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

// The cost and usage drawer lived only on Now; with Now retired it was a
// Surface panel (glmps-2-0-63). Card glmps-2-0-137 moved it to a full-width
// Work tab (phase 4) and took the Surface panel away (phase 2): Surface no
// longer loads analytics, and every way in leads to Work > Cost.
test('Surface no longer opens a cost panel; the analytics module loads on Work', () => {
  const lens = read('web/surface/lens.js');
  assert.doesNotMatch(lens, /panels\.open\('cost'/);
  assert.doesNotMatch(lens, /observability\/analytics\.js/);
});

test('Surface loads the drawer stylesheet', () => {
  assert.match(read('web/app.js'), /registerView\('surface'[\s\S]*?'\/observability\/budget\.css'/);
});

test('the topbar usage figure, old analytics links and the old Surface cost panel link lead to Work > Cost', () => {
  assert.equal(fs.existsSync(new URL('../../web/surface/pulse.js', import.meta.url)), false, 'the Pulse budget row is retired with its dock');
  assert.match(read('web/app.js'), /stat-usage', linkFor\(\{ lens: 'work', tab: 'cost' \}\)/);
  assert.deepEqual(LEGACY_VIEWS.analytics, { lens: 'work', tab: 'cost' });
  assert.equal(linkFor(parseLink('/surface', '?panel=cost')), '/work?tab=cost');
});
