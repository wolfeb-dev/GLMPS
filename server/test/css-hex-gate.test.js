// the colour-debt gate. Raw hex literals per stylesheet may only go down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countHex, scan, loadBaseline, compare } from '../../scripts/css-hex-gate.mjs';

test('countHex counts values in rules, not selectors, comments, strings, url() or token definitions', () => {
  assert.equal(countHex('a { color: #fff; border: 1px solid #1a2b3c; background: #11223344; }'), 3);
  assert.equal(countHex('#abc, #add .x { color: red; }'), 0);
  assert.equal(countHex('a { /* #fff */ color: red; content: "#fff"; background: url(x.svg#fff); }'), 0);
  assert.equal(countHex(':root { --a: #fff; --b: #000000; color: #123; }'), 1);
  assert.equal(countHex('@media (x) { a { color: #fff } }'), 1);
  assert.equal(countHex('a { color: color-mix(in srgb, #e05656 45%, red); }'), 1);
});

test('no stylesheet exceeds its committed baseline and no new stylesheet has a literal', () => {
  const failures = compare(scan(), loadBaseline());
  assert.deepEqual(failures, [], failures.map((f) => `${f.file}: ${f.count} > ${f.allowed}`).join('\n'));
});

test('compare flags a raise and a new stylesheet with literals', () => {
  assert.equal(compare({ 'web/a.css': 2 }, { 'web/a.css': 1 }).length, 1);
  assert.equal(compare({ 'web/new.css': 1 }, {}).length, 1);
  assert.equal(compare({ 'web/new.css': 0, 'web/a.css': 1 }, { 'web/a.css': 1 }).length, 0);
});

// card glmps-2-0-runtime-77 AC-3: the colour debt is paid. Every stylesheet's
// baseline is zero, so any new literal fails the gate; a colour belongs in
// web/shared/tokens.css as a custom property.
test('every stylesheet is at zero', () => {
  const base = loadBaseline();
  assert.ok(Object.keys(base).length > 0);
  assert.deepEqual(Object.entries(base).filter(([, n]) => n !== 0), []);
  assert.deepEqual(Object.entries(scan()).filter(([, n]) => n !== 0), []);
});
