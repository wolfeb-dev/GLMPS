import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdict, verify, execGatePassed, fromGateStatus } from '../lib/orchestration/verify.js';


test('verify is an alias for verdict (spec names either import)', () => {
  assert.equal(verify, verdict);
});


test('a failing execution check short-circuits to fail before any critic is consulted', () => {
  const checks = [{ gate: 'exec', status: 'fail', name: 'unit tests' }];
  const result = verdict(checks);
  assert.deepEqual(result, { verdict: 'fail', gate: 'exec', failedBy: ['unit tests'] });
});

test('execGatePassed lets a caller decide NOT to dispatch the critic at all', () => {
  // This is the strongest form of the veto: the critic is never invoked, not
  // merely ignored after the fact -- a caller (e.g. the /gate handler) checks
  // this BEFORE making any network call.
  assert.equal(execGatePassed([{ gate: 'exec', status: 'fail' }]), false);
  assert.equal(execGatePassed([{ gate: 'exec', status: 'pass' }]), true);
  assert.equal(execGatePassed([{ gate: 'exec', status: 'concerns' }]), true);
  assert.equal(execGatePassed([]), true); // no declared execution checks -> nothing to veto
});

test('an LLM critic cannot overturn a failed execution check to pass', () => {
  const checks = [
    { gate: 'exec', status: 'fail', name: 'unit tests' },
    { gate: 'critic', status: 'pass', name: 'cross-model critic' },
  ];
  const result = verdict(checks);
  assert.equal(result.verdict, 'fail');
  assert.equal(result.gate, 'exec');
  // The critic's 'pass' is not even cited -- the exec failure is the whole story.
  assert.deepEqual(result.failedBy, ['unit tests']);
});

test('multiple failing execution checks are all named in failedBy', () => {
  const checks = [
    { gate: 'exec', status: 'fail', name: 'unit tests' },
    { gate: 'exec', status: 'fail', name: 'lint' },
    { gate: 'exec', status: 'pass', name: 'typecheck' },
  ];
  const result = verdict(checks);
  assert.equal(result.verdict, 'fail');
  assert.deepEqual(result.failedBy, ['unit tests', 'lint']);
});


test('an independent critic can downgrade a passing execution check to concerns', () => {
  const checks = [
    { gate: 'exec', status: 'pass' },
    { gate: 'critic', status: 'concerns', name: 'cross-model critic' },
  ];
  const result = verdict(checks);
  assert.equal(result.verdict, 'concerns');
  assert.equal(result.gate, 'critic');
  assert.deepEqual(result.failedBy, ['cross-model critic']);
});

test('an independent critic can downgrade a passing execution check all the way to fail', () => {
  const checks = [
    { gate: 'exec', status: 'pass' },
    { gate: 'critic', status: 'fail', name: 'cross-model critic' },
  ];
  const result = verdict(checks);
  assert.equal(result.verdict, 'fail');
  assert.equal(result.gate, 'critic');
});

test('a critic that agrees (pass) never raises the verdict or changes the gate away from exec', () => {
  const checks = [
    { gate: 'exec', status: 'pass' },
    { gate: 'critic', status: 'pass', name: 'cross-model critic' },
  ];
  const result = verdict(checks);
  assert.deepEqual(result, { verdict: 'pass', gate: 'critic', failedBy: [] });
});


test('pass-through when no oracle exists: exactly one cross-model critic verdict decides it', () => {
  const checks = [{ gate: 'critic', status: 'pass', name: 'cross-model critic' }];
  const result = verdict(checks);
  assert.deepEqual(result, { verdict: 'pass', gate: 'critic', failedBy: [] });
});

test('pass-through: a lone critic concerns verdict surfaces with no exec checks present', () => {
  const checks = [{ gate: 'critic', status: 'concerns', name: 'cross-model critic' }];
  const result = verdict(checks);
  assert.equal(result.verdict, 'concerns');
  assert.equal(result.gate, 'critic');
});

test('no checks at all is a vacuous pass with no gate', () => {
  assert.deepEqual(verdict([]), { verdict: 'pass', gate: null, failedBy: [] });
  assert.deepEqual(verdict(), { verdict: 'pass', gate: null, failedBy: [] });
});


test('panel aggregates by ensemble-mean/severity, not naive majority-count', () => {
  // 3 reviewers pass, 2 flag fail. A naive majority-count (3 beats 2) would
  // read this as a clean pass; mean-severity surfaces the two real negatives
  // instead of averaging them away (the "Beyond Consensus" agreeableness-bias
  // finding the ensemble-mean rule guards against).
  const checks = [
    { gate: 'exec', status: 'pass' },
    { gate: 'panel', status: 'pass', name: 'r1' },
    { gate: 'panel', status: 'pass', name: 'r2' },
    { gate: 'panel', status: 'pass', name: 'r3' },
    { gate: 'panel', status: 'fail', name: 'r4' },
    { gate: 'panel', status: 'fail', name: 'r5' },
  ];
  const result = verdict(checks);

  // Naive majority-count over the same panel would say 'pass' (3 > 2).
  const passCount = checks.filter(c => c.gate === 'panel' && c.status === 'pass').length;
  const failCount = checks.filter(c => c.gate === 'panel' && c.status === 'fail').length;
  const naiveMajority = passCount > failCount ? 'pass' : 'fail';
  assert.equal(naiveMajority, 'pass');

  // Ensemble-mean severity: (0+0+0+2+2)/5 = 0.8 -> 'concerns', diverging from
  // the naive majority-count verdict computed above.
  assert.equal(result.verdict, 'concerns');
  assert.equal(result.gate, 'panel');
  assert.notEqual(result.verdict, naiveMajority);
});

test('panel with an overwhelming severe majority reaches fail, not just concerns', () => {
  const checks = [
    { gate: 'panel', status: 'fail', name: 'r1' },
    { gate: 'panel', status: 'fail', name: 'r2' },
    { gate: 'panel', status: 'concerns', name: 'r3' },
  ];
  // mean = (2+2+1)/3 = 1.667 -> fail.
  const result = verdict(checks);
  assert.equal(result.verdict, 'fail');
  assert.equal(result.gate, 'panel');
});

test('panel with all-pass reviewers stays a clean pass', () => {
  const checks = [
    { gate: 'exec', status: 'pass' },
    { gate: 'panel', status: 'pass', name: 'r1' },
    { gate: 'panel', status: 'pass', name: 'r2' },
  ];
  assert.deepEqual(verdict(checks), { verdict: 'pass', gate: 'panel', failedBy: [] });
});


test('fromGateStatus maps the ticket gate vocabulary onto pass|concerns|fail|skipped', () => {
  assert.equal(fromGateStatus('PASS'), 'pass');
  assert.equal(fromGateStatus('CONCERNS'), 'concerns');
  assert.equal(fromGateStatus('FAIL'), 'fail');
  // A waiver means nothing was evaluated, so it is neither a pass nor a fail.
  assert.equal(fromGateStatus('WAIVED'), 'skipped');
  assert.equal(fromGateStatus(undefined), 'skipped');
  assert.equal(fromGateStatus('bogus'), 'skipped');
});

test('a skipped check never reads as a clean pass and never as a fail', () => {
  const only = verdict([{ gate: 'exec', status: 'skipped', name: 'waived exec' }]);
  assert.equal(only.verdict, 'skipped');
  assert.equal(only.gate, 'exec');
  assert.deepEqual(only.failedBy, ['waived exec']);
  // An unknown status is treated the same as skipped.
  assert.equal(verdict([{ gate: 'exec', status: 'weird' }]).verdict, 'skipped');
});

test('skipped does not veto a critic and a critic pass does not launder it', () => {
  assert.equal(verdict([{ gate: 'exec', status: 'skipped' }, { gate: 'critic', status: 'fail' }]).verdict, 'fail');
  assert.equal(verdict([{ gate: 'exec', status: 'skipped' }, { gate: 'critic', status: 'pass' }]).verdict, 'skipped');
  assert.equal(execGatePassed([{ gate: 'exec', status: 'skipped' }]), true);
});

test('skipped panel members are left out of the mean, an all-skipped panel is skipped', () => {
  const mixed = verdict([
    { gate: 'panel', status: 'pass' }, { gate: 'panel', status: 'skipped' }, { gate: 'panel', status: 'pass' },
  ]);
  assert.equal(mixed.verdict, 'pass');
  assert.equal(verdict([{ gate: 'panel', status: 'skipped' }]).verdict, 'skipped');
  assert.equal(verdict([{ gate: 'panel', status: 'fail' }, { gate: 'panel', status: 'skipped' }]).verdict, 'fail');
});


test('checks with an unrecognized gate value are ignored (forward-compatible)', () => {
  const checks = [{ gate: 'mystery-layer', status: 'fail', name: 'unknown' }];
  assert.deepEqual(verdict(checks), { verdict: 'pass', gate: null, failedBy: [] });
});
