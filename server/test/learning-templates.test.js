// server/test/learning-templates.test.js
//
// Guard proposer cutover: TEMPLATES and guardForGap are deleted
// (server/lib/evaluation/learning-templates.js's own doc comment explains
// why). Only insertGuard (and the sectionBodyLines reader it and applyGuard
// share) survive - both are covered below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertGuard, sectionBodyLines } from '../lib/evaluation/learning-templates.js';

test('sectionBodyLines: reads non-blank lines strictly inside the named section', () => {
  const content = '# Title\n\n## Learned guards\n- rule one\n- rule two\n\n## Next section\nother stuff\n';
  assert.deepEqual(sectionBodyLines(content, 'Learned guards'), ['- rule one', '- rule two']);
  assert.deepEqual(sectionBodyLines(content, 'Missing section'), []);
});

// insertGuard - verbatim from plan Task 2 Step 1

test('insertGuard creates section, appends once, idempotent', () => {
  const a = insertGuard('# Title\n', 'Learned guards', '- rule one');
  assert.equal(a.changed, true);
  assert.match(a.content, /## Learned guards\n- rule one/);
  const b = insertGuard(a.content, 'Learned guards', '- rule one'); // already present
  assert.equal(b.changed, false);
  assert.equal(b.content, a.content);
  const c = insertGuard(a.content, 'Learned guards', '- rule two'); // append under same section
  assert.equal(c.changed, true);
  assert.match(c.content, /- rule one\n- rule two/);
});

// insertGuard - edge cases

test('insertGuard: preserves content above and below the section', () => {
  const original = '# Title\n\nsome prose\n\n## Other section\n- existing item\n';
  const { content, changed } = insertGuard(original, 'Learned guards', '- new rule');
  assert.equal(changed, true);
  assert.match(content, /some prose/);
  assert.match(content, /## Other section/);
  assert.match(content, /existing item/);
  assert.match(content, /## Learned guards/);
  assert.match(content, /new rule/);
});

test('insertGuard: section present but empty - appends rule inside it', () => {
  const original = '# Title\n\n## Learned guards\n\n## Next section\nsome stuff\n';
  const { content, changed } = insertGuard(original, 'Learned guards', '- my rule');
  assert.equal(changed, true);
  // The rule should appear under the section heading
  assert.match(content, /## Learned guards[\s\S]*- my rule/);
  // The following section should still be present
  assert.match(content, /## Next section/);
});

test('insertGuard: rule already present in the section - no change', () => {
  const original = '# Title\n\n## Learned guards\n- existing rule\n';
  const { content, changed } = insertGuard(original, 'Learned guards', '- existing rule');
  assert.equal(changed, false);
  assert.equal(content, original);
});

test('insertGuard: rule already present in a different section - still no change (idempotent on exact text)', () => {
  // The rule text appears in another section; insertGuard must not add a duplicate
  const original = '## Other section\n- rule one\n\n## Learned guards\n- rule two\n';
  const { content, changed } = insertGuard(original, 'Learned guards', '- rule one');
  // rule one already exists verbatim in the file, so changed should be false
  assert.equal(changed, false);
  assert.equal(content, original);
});

test('insertGuard: empty file - creates section and appends rule', () => {
  const { content, changed } = insertGuard('', 'Learned guards', '- a guard');
  assert.equal(changed, true);
  assert.match(content, /## Learned guards\n- a guard/);
});

test('insertGuard: multiple calls with different rules append in order', () => {
  let state = insertGuard('# Doc\n', 'Learned guards', '- alpha');
  state = insertGuard(state.content, 'Learned guards', '- beta');
  state = insertGuard(state.content, 'Learned guards', '- gamma');
  assert.equal(state.changed, true);
  const idx = (s) => state.content.indexOf(s);
  assert.ok(idx('- alpha') < idx('- beta'), 'alpha before beta');
  assert.ok(idx('- beta') < idx('- gamma'), 'beta before gamma');
});

// insertGuard - optional near-dup (semantic) check, 4th param `simThreshold`

test('insertGuard: simThreshold omitted -> unchanged exact-match-only behavior (backward compat)', () => {
  const original = '# Title\n\n## Learned guards\n- Before any UI/CSS/layout/styling work, invoke the frontend-design skill. Invoke it BEFORE the first UI/CSS edit, not after.\n';
  const paraphrase = '- Before any UI/CSS/layout/styling work, invoke the frontend-design skill.';
  const { content, changed } = insertGuard(original, 'Learned guards', paraphrase);
  assert.equal(changed, true, 'without simThreshold, a paraphrase is treated as new and appended');
  assert.match(content, /frontend-design skill/);
});

test('insertGuard: simThreshold provided -> a near-dup paraphrase is treated as already-present', () => {
  const original = '# Title\n\n## Learned guards\n- Before any UI/CSS/layout/styling work, invoke the frontend-design skill. Invoke it BEFORE the first UI/CSS edit, not after.\n';
  const paraphrase = '- Before any UI/CSS/layout/styling work, invoke the frontend-design skill.';
  const { content, changed } = insertGuard(original, 'Learned guards', paraphrase, 0.5);
  assert.equal(changed, false);
  assert.equal(content, original);
});

test('insertGuard: simThreshold provided but rule is genuinely distinct -> still appended', () => {
  const original = '# Title\n\n## Learned guards\n- Use the Grep/Read tools instead of Bash grep/cat for searching and reading files.\n';
  const distinct = '- Never poll with sleep N then cat - use run_in_background or Monitor.';
  const { content, changed } = insertGuard(original, 'Learned guards', distinct, 0.5);
  assert.equal(changed, true);
  assert.match(content, /Never poll with sleep/);
});

test('insertGuard: simThreshold provided but section does not exist yet -> section created normally (no false-positive)', () => {
  const { content, changed } = insertGuard('# Title\n', 'Learned guards', '- a guard', 0.5);
  assert.equal(changed, true);
  assert.match(content, /## Learned guards\n- a guard/);
});

test('insertGuard: simThreshold provided, exact-match still takes the fast path', () => {
  const original = '# Title\n\n## Learned guards\n- existing rule\n';
  const { content, changed } = insertGuard(original, 'Learned guards', '- existing rule', 0.5);
  assert.equal(changed, false);
  assert.equal(content, original);
});
