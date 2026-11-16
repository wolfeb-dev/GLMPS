// server/test/tap-logon-task.test.js
// Tap agent skeleton (card glmps-2-0-runtime-31): the logon scheduled task module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { logonTaskXml, planLogonTask, applyLogonTask, LOGON_TASK_NAME } from '../../taps/tap-logon-task.js';

const args = { userId: 'S-1-5-21-1-2-3-1001', nodePath: 'C:\\Users\\u\\AppData\\Local\\GLMPS\\tap\\node.exe', agentPath: 'C:\\Users\\u\\AppData\\Local\\GLMPS\\tap\\taps\\tap-agent.js' };

test('the task XML triggers at that user\'s logon, runs the agent headless and restarts it on failure', () => {
  const xml = logonTaskXml(args);
  assert.match(xml, /<LogonTrigger>[\s\S]*<UserId>S-1-5-21-1-2-3-1001<\/UserId>[\s\S]*<\/LogonTrigger>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<RestartOnFailure>[\s\S]*<Interval>PT1M<\/Interval>[\s\S]*<\/RestartOnFailure>/);
  assert.match(xml, /<Command>conhost\.exe<\/Command>/);
  assert.match(xml, /<Arguments>--headless "C:\\Users\\u\\AppData\\Local\\GLMPS\\tap\\node\.exe" "C:\\Users\\u\\AppData\\Local\\GLMPS\\tap\\taps\\tap-agent\.js"<\/Arguments>/);
  assert.match(xml, new RegExp(`<URI>${LOGON_TASK_NAME.replaceAll('\\', '\\\\')}</URI>`));
});

test('XML-significant characters in a path are escaped', () => {
  const xml = logonTaskXml({ ...args, nodePath: 'C:\\A&B\\<n>\\node.exe' });
  assert.match(xml, /A&amp;B\\&lt;n&gt;\\node\.exe/);
});

test('logonTaskXml refuses a missing field', () => {
  for (const k of Object.keys(args)) assert.throws(() => logonTaskXml({ ...args, [k]: '' }), new RegExp(k));
});

test('planLogonTask: register when absent, nothing when the task already has this XML, re-register when it differs', () => {
  const xml = logonTaskXml(args);
  assert.deepEqual(planLogonTask(args, { queryTaskXml: () => ({ state: 'absent' }) }), { ok: true, todo: true, action: 'register', xml });
  const same = planLogonTask(args, { queryTaskXml: () => ({ state: 'present', xml }) });
  assert.equal(same.todo, false);
  const differ = planLogonTask(args, { queryTaskXml: () => ({ state: 'present', xml: xml.replace('PT1M', 'PT5M') }) });
  assert.equal(differ.todo, true);
  assert.equal(differ.action, 'update');
  assert.equal(differ.previousXml.includes('PT5M'), true);
});

test('planLogonTask: an unreadable task is a refusal, not a guess', () => {
  const p = planLogonTask(args, { queryTaskXml: () => ({ state: 'unknown', reason: 'boom' }) });
  assert.equal(p.ok, false);
  assert.match(p.reason, /boom/);
});

test('applyLogonTask hands the XML to the injected runner, and does nothing when there is nothing to do', () => {
  const given = [];
  const plan = planLogonTask(args, { queryTaskXml: () => ({ state: 'absent' }) });
  const logs = [];
  assert.deepEqual(applyLogonTask(plan, { createTask: (x) => { given.push(x); return { ok: true }; }, log: (l) => logs.push(l) }), { ok: true });
  assert.equal(given.length, 1);
  assert.equal(given[0], plan.xml);
  const noop = planLogonTask(args, { queryTaskXml: () => ({ state: 'present', xml: plan.xml }) });
  assert.deepEqual(applyLogonTask(noop, { createTask: () => { throw new Error('should not run'); }, log: () => {} }), { ok: true });
  assert.deepEqual(applyLogonTask({ ok: false, reason: 'x' }, { createTask: () => { throw new Error('no'); } }), { ok: false, reason: 'x' });
  const failed = applyLogonTask(plan, { createTask: () => ({ ok: false, reason: 'denied' }), log: () => {} });
  assert.deepEqual(failed, { ok: false, reason: 'denied' });
});

test('the module never registers anything at import time', () => {
  const src = fs.readFileSync(new URL('../../taps/tap-logon-task.js', import.meta.url), 'utf8');
  assert.equal(/process\.argv/.test(src), false, 'no main-script entry: task 7 owns the installer');
});
