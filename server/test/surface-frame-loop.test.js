// Module under test: web/surface/frame-loop.js (the one requestAnimationFrame loop)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrameLoop } from '../../web/surface/frame-loop.js';

function rig(stepResults) {
  const frames = new Map(); let nextId = 1; const listeners = new Set(); let steps = 0;
  const doc = { hidden: false, addEventListener: (t, fn) => { if (t === 'visibilitychange') listeners.add(fn); }, removeEventListener: (t, fn) => listeners.delete(fn) };
  const loop = createFrameLoop({
    doc,
    raf: (fn) => { const id = nextId++; frames.set(id, fn); return id; },
    caf: (id) => frames.delete(id),
    step: () => { steps++; return stepResults.shift() ?? false; },
  });
  const runFrame = () => { const [[id, fn]] = frames; frames.delete(id); fn(0); };
  const setHidden = (h) => { doc.hidden = h; for (const fn of listeners) fn(); };
  return { loop, frames, runFrame, setHidden, steps: () => steps, listeners };
}

test('the loop is idle until woken, and stops by itself when a step reports nothing moving', () => {
  const r = rig([true, true, false]);
  assert.equal(r.frames.size, 0, 'no frame is asked for before anything moves');
  r.loop.wake(); r.loop.wake();
  assert.equal(r.frames.size, 1, 'waking twice still asks for one frame');
  r.runFrame(); r.runFrame();
  assert.equal(r.frames.size, 1);
  r.runFrame();
  assert.equal(r.frames.size, 0, 'the last step said nothing moves, so no frame is left queued');
  assert.equal(r.steps(), 3);
  assert.equal(r.loop.active(), false);
});

test('a hidden tab cancels the frame and cannot start one; showing it again resumes', () => {
  const r = rig([true, true, true]);
  r.loop.wake();
  r.setHidden(true);
  assert.equal(r.frames.size, 0);
  r.loop.wake();
  assert.equal(r.frames.size, 0, 'no frame while hidden');
  r.setHidden(false);
  assert.equal(r.frames.size, 1, 'visible again with work pending: one frame');
});

test('destroy cancels the frame and removes the visibility listener', () => {
  const r = rig([true]);
  r.loop.wake();
  r.loop.destroy();
  assert.equal(r.frames.size, 0);
  assert.equal(r.listeners.size, 0);
  r.loop.wake();
  assert.equal(r.frames.size, 0, 'a destroyed loop never asks for a frame again');
});
