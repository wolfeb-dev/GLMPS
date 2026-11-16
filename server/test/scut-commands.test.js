// Tests for SCUT chat-verb parsing (server/lib/scut/commands.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../lib/scut/commands.js';

test('parseCommand recognizes the status verb and its aliases', () => {
  assert.deepEqual(parseCommand('status'), { cmd: 'status', arg: '' });
  assert.deepEqual(parseCommand('jobs'), { cmd: 'status', arg: '' });
  assert.deepEqual(parseCommand('running'), { cmd: 'status', arg: '' });
  assert.deepEqual(parseCommand("what's running"), { cmd: 'status', arg: '' });
  assert.deepEqual(parseCommand('whats running'), { cmd: 'status', arg: '' });
});

test('parseCommand recognizes stop and its aliases, with an id', () => {
  assert.deepEqual(parseCommand('stop glmps-42'), { cmd: 'stop', arg: 'glmps-42' });
  assert.deepEqual(parseCommand('cancel glmps-42'), { cmd: 'stop', arg: 'glmps-42' });
  assert.deepEqual(parseCommand('halt glmps-42'), { cmd: 'stop', arg: 'glmps-42' });
});

test('a bare stop with no id returns an empty arg - the handler must ask, never guess', () => {
  assert.deepEqual(parseCommand('stop'), { cmd: 'stop', arg: '' });
  assert.deepEqual(parseCommand('cancel'), { cmd: 'stop', arg: '' });
  assert.deepEqual(parseCommand('halt'), { cmd: 'stop', arg: '' });
});

test('parseCommand recognizes help and its aliases', () => {
  assert.deepEqual(parseCommand('help'), { cmd: 'help', arg: '' });
  assert.deepEqual(parseCommand('commands'), { cmd: 'help', arg: '' });
  assert.deepEqual(parseCommand('?'), { cmd: 'help', arg: '' });
});

test('parseCommand is case-insensitive and trims surrounding whitespace', () => {
  assert.deepEqual(parseCommand('STATUS'), { cmd: 'status', arg: '' });
  assert.deepEqual(parseCommand('  Status  '), { cmd: 'status', arg: '' });
  assert.deepEqual(parseCommand('Stop GLMPS-42'), { cmd: 'stop', arg: 'GLMPS-42' });
  assert.deepEqual(parseCommand('HELP'), { cmd: 'help', arg: '' });
});

test('a normal instruction is not a command', () => {
  assert.equal(parseCommand('builder do the thing'), null);
  assert.equal(parseCommand('please fix the bug in the parser'), null);
  assert.equal(parseCommand('build a new dashboard widget'), null);
});

test('only a LEADING verb counts - a message that merely contains the word mid-sentence falls through', () => {
  // The exact case called out by the plan: this must NOT parse as a status
  // command, or an ordinary sentence silently stops doing work.
  assert.equal(parseCommand('can you check the status of the build'), null);
  assert.equal(parseCommand('is anything running right now'), null);
  assert.equal(parseCommand('please stop overengineering this'), null);
  assert.equal(parseCommand('what commands do you support'), null);
});

test('a leading verb must be a whole word, not a prefix of a longer word', () => {
  assert.equal(parseCommand('stopwatch app'), null);
  assert.equal(parseCommand('statuses of everything'), null);
  assert.equal(parseCommand('helping with the build'), null);
});

test('empty, whitespace-only, or missing text is not a command', () => {
  assert.equal(parseCommand(''), null);
  assert.equal(parseCommand('   '), null);
  assert.equal(parseCommand(undefined), null);
  assert.equal(parseCommand(null), null);
});


test('approve and deny parse as leading verbs with a gate id', () => {
  assert.deepEqual(parseCommand('approve g-1-abc'), { cmd: 'approve', arg: 'g-1-abc' });
  assert.deepEqual(parseCommand('deny g-1-abc'), { cmd: 'deny', arg: 'g-1-abc' });
});

test('short forms work, because an AFK approval should be one thumb-typed word', () => {
  assert.equal(parseCommand('ok g-1')?.cmd, 'approve');
  assert.equal(parseCommand('yes g-1')?.cmd, 'approve');
  assert.equal(parseCommand('no g-1')?.cmd, 'deny');
  assert.equal(parseCommand('reject g-1')?.cmd, 'deny');
});

test('an ordinary sentence containing approve/deny still routes as work', () => {
  // Same leading-verb rule the existing verbs use: these words are far too
  // common in ordinary instructions to actuate mid-sentence.
  assert.equal(parseCommand('can you approve the design doc first'), null);
  assert.equal(parseCommand('the reviewer will deny this if we skip tests'), null);
  assert.equal(parseCommand('approver notes are in the ticket'), null);
  assert.equal(parseCommand('nobody reviewed it'), null);
});

test('a bare approve with no gate id still parses, so the handler can ask which', () => {
  assert.deepEqual(parseCommand('approve'), { cmd: 'approve', arg: '' });
});


test('close is a leading verb with an optional ticket id', () => {
  assert.deepEqual(parseCommand('close'), { cmd: 'close', arg: '' });
  assert.deepEqual(parseCommand('close glmps-7'), { cmd: 'close', arg: 'glmps-7' });
  assert.equal(parseCommand('closet cleanup please'), null);
  assert.equal(parseCommand('please close the door'), null);
});

// Unattended reliability T5: the launch mode override.
test('mode is a leading verb only when it names a mode, with an optional ticket id in either order', () => {
  assert.deepEqual(parseCommand('mode interactive'), { cmd: 'mode', arg: 'interactive', mode: 'interactive', id: '' });
  assert.deepEqual(parseCommand('mode headless glmps-2-0-9'), { cmd: 'mode', arg: 'headless glmps-2-0-9', mode: 'headless', id: 'glmps-2-0-9' });
  assert.deepEqual(parseCommand('Mode glmps-4 Interactive'), { cmd: 'mode', arg: 'glmps-4 Interactive', mode: 'interactive', id: 'glmps-4' });
  assert.deepEqual(parseCommand('mode auto glmps-4'), { cmd: 'mode', arg: 'auto glmps-4', mode: null, id: 'glmps-4' });
  assert.deepEqual(parseCommand('mode'), { cmd: 'mode', arg: '', mode: undefined, id: '' });
  assert.equal(parseCommand('mode switch for the dark theme'), null, 'an ordinary instruction still routes');
  assert.equal(parseCommand('modest change please'), null);
  assert.equal(parseCommand('mode headless glmps-4 now'), null, 'more than an id and a mode is not the verb');
});

// glmps-2-0-171 D5: run/drop take only ticket ids, so "run the tests" still routes as an instruction.
test('run and drop are verbs only when every following word is a ticket id', () => {
  assert.deepEqual(parseCommand('run glmps-2-0-152'), { cmd: 'run', arg: 'glmps-2-0-152', ids: ['glmps-2-0-152'] });
  assert.deepEqual(parseCommand('Drop glmps-4 mc-9'), { cmd: 'drop', arg: 'glmps-4 mc-9', ids: ['glmps-4', 'mc-9'] });
  assert.deepEqual(parseCommand('run glmps-2-0-runtime-47, glmps-2-0-152'), { cmd: 'run', arg: 'glmps-2-0-runtime-47, glmps-2-0-152', ids: ['glmps-2-0-runtime-47', 'glmps-2-0-152'] });
  assert.equal(parseCommand('run the tests'), null);
  assert.equal(parseCommand('run glmps-4 now'), null);
  assert.equal(parseCommand('drop the db table'), null);
  assert.equal(parseCommand('run'), null, 'a bare run is an ordinary word');
  assert.equal(parseCommand('dropdown menu is broken'), null);
});
