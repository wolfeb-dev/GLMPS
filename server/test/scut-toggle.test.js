// Tests for the SCUT Bob-mode toggle logic (server/lib/scut/toggle.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent, applyToggle } from '../lib/scut/toggle.js';

test('parseIntent understands on/off/status/toggle and the magic phrase', () => {
  assert.equal(parseIntent('on'), 'on');
  assert.equal(parseIntent('enable'), 'on');
  assert.equal(parseIntent('off'), 'off');
  assert.equal(parseIntent('disable'), 'off');
  assert.equal(parseIntent('status'), 'status');
  assert.equal(parseIntent(''), 'toggle');
  assert.equal(parseIntent('toggle'), 'toggle');
  assert.equal(parseIntent('we are legion'), 'on');   // Easter egg
  assert.equal(parseIntent('We Are Bob'), 'on');      // Easter egg (case-insensitive)
  assert.equal(parseIntent('something else'), null);
});

function store(initial = false) {
  let v = initial;
  return { getBobMode: () => v, setBobMode: (on) => { v = on; return v; }, peek: () => v };
}

test('applyToggle on/off changes the flag and returns a message', () => {
  const s = store(false);
  const on = applyToggle('on', s);
  assert.equal(on.changed, true);
  assert.equal(on.bobMode, true);
  assert.match(on.message, /legion/i);
  assert.equal(s.peek(), true);

  const off = applyToggle('off', s);
  assert.equal(off.changed, true);
  assert.equal(off.bobMode, false);
  assert.match(off.message, /business/i);
});

test('applyToggle toggle flips; status does not change', () => {
  const s = store(false);
  assert.equal(applyToggle('toggle', s).bobMode, true);
  assert.equal(applyToggle('toggle', s).bobMode, false);
  const st = applyToggle('status', s);
  assert.equal(st.changed, false);
  assert.match(st.message, /OFF/);
});

test('applyToggle on when already on: no change, informative message', () => {
  const s = store(true);
  const r = applyToggle('on', s);
  assert.equal(r.changed, false);
  assert.equal(r.bobMode, true);
  assert.match(r.message, /already/i);
});
