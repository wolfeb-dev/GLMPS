// affected-tests: always
// server/test/web-dom-util.test.js
// glmps-63: unit tests for web/shared/dom-util.js - setText and cwdLastSeg
// were duplicated (byte-identically, modulo param naming) across ~10 view
// modules; this is the single copy they now all import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setText, cwdLastSeg, metricValue, evidenceLabel, clear } from '../../web/shared/dom-util.js';

// No real DOM needed: setText only ever assigns .textContent, so a plain
// object with that property stands in for an Element.
test('setText assigns String(s) to .textContent', () => {
  const node = { textContent: '' };
  setText(node, 'hello');
  assert.equal(node.textContent, 'hello');
});

test('setText coerces non-string values via String()', () => {
  const node = { textContent: '' };
  setText(node, 42);
  assert.equal(node.textContent, '42');
});

test('setText coerces null/undefined to an empty string (never "null"/"undefined")', () => {
  const node = { textContent: 'stale' };
  setText(node, null);
  assert.equal(node.textContent, '');
  setText(node, undefined);
  assert.equal(node.textContent, '');
});

test('cwdLastSeg handles forward/back slashes and trailing separators', () => {
  assert.equal(cwdLastSeg('D:\\glmps'), 'glmps');
  assert.equal(cwdLastSeg('/home/u/proj/'), 'proj');
  assert.equal(cwdLastSeg('C:/a/b/c\\d'), 'd');
  assert.equal(cwdLastSeg(''), '');
  assert.equal(cwdLastSeg(null), '');
  assert.equal(cwdLastSeg(undefined), '');
});

// glmps loop-measurement-honesty Task 4: server/lib/evaluation/evidence.js's
// tagValue() wraps every summarized loop metric as {value, evidence, n,
// reason?} instead of a bare number. These two helpers are the single place
// every view module unwraps that envelope for display.
test('metricValue unwraps a tagged envelope, passes a bare value straight through', () => {
  assert.equal(metricValue({ value: 4, evidence: 'measured', n: 10 }), 4);
  assert.equal(metricValue({ value: null, evidence: 'absent', n: 0 }), null);
  assert.equal(metricValue(5), 5);
  assert.equal(metricValue(null), null);
  assert.equal(metricValue(undefined), undefined);
  assert.equal(metricValue(true), true);
});

test('evidenceLabel returns null for measured envelopes and bare values (caller falls through to its own formatter)', () => {
  assert.equal(evidenceLabel({ value: 4, evidence: 'measured', n: 10 }), null);
  assert.equal(evidenceLabel(5), null);
  assert.equal(evidenceLabel(null), null);
  assert.equal(evidenceLabel(undefined), null);
});

test('evidenceLabel names an absent metric as "not captured"', () => {
  assert.equal(evidenceLabel({ value: null, evidence: 'absent', n: 0 }), 'not captured');
});

test('evidenceLabel names a constant metric with its sample size', () => {
  assert.equal(evidenceLabel({ value: 1, evidence: 'constant', n: 65, reason: 'zero variance' }), 'no variance (n=65)');
});

test('clear empties a node through replaceChildren()', () => {
  let calls = 0;
  const node = { replaceChildren: (...args) => { calls++; assert.equal(args.length, 0); } };
  clear(node);
  assert.equal(calls, 1);
});

test('web/ code clears containers through clear(), never by assigning innerHTML', () => {
  const root = path.resolve(import.meta.dirname, '..', '..', 'web');
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); continue; }
      if (!e.name.endsWith('.js') || e.name.endsWith('.min.js')) continue;
      fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (/\.innerHTML\s*=(?!=)/.test(line)) offenders.push(`${path.relative(root, p)}:${i + 1}`);
      });
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});
