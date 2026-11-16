import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerProducer, collectSignals, _resetProducers } from '../lib/evaluation/signal-producer.js';

test('no producers registered -> empty array', () => {
  _resetProducers();
  assert.deepEqual(collectSignals(), []);
});

test('registered producers are concatenated in registration order', () => {
  _resetProducers();
  registerProducer(() => [{ source: 'a', severity: 'info', title: 't1', detail: '', target: null, ts: 1 }]);
  registerProducer(() => [{ source: 'b', severity: 'warn', title: 't2', detail: '', target: null, ts: 2 }]);
  const rows = collectSignals();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, 'a');
  assert.equal(rows[1].source, 'b');
});

test('a throwing producer is skipped; others still contribute (fail-open)', () => {
  _resetProducers();
  registerProducer(() => { throw new Error('boom'); });
  registerProducer(() => [{ source: 'ok', severity: 'info', title: 't', detail: '', target: null, ts: 1 }]);
  const rows = collectSignals();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'ok');
});

test('a producer returning a non-array is ignored, not thrown', () => {
  _resetProducers();
  registerProducer(() => null);
  registerProducer(() => [{ source: 'ok2', severity: 'info', title: 't', detail: '', target: null, ts: 1 }]);
  const rows = collectSignals();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'ok2');
});

test('registerProducer ignores non-function input', () => {
  _resetProducers();
  registerProducer('not a function');
  registerProducer(42);
  assert.deepEqual(collectSignals(), []);
});
