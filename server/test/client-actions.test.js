import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathIssue, insideRoots, ownerOfSession, ownerOfPath, resolveTarget } from '../lib/kernel/client-actions.js';

const cl = (id, projectRoots, extra = {}) => ({ id, name: `box-${id}`, paired: true, revokedTs: null, projectRoots, ...extra });
const A = cl('cli_aaa', ['C:\\Work\\Alpha', 'C:\\Work']);
const B = cl('cli_bbb', ['D:/repos/beta']);

test('pathIssue refuses relative, dotdot, UNC and device paths', () => {
  assert.equal(pathIssue('C:\\Work\\a.txt'), null);
  assert.equal(pathIssue('/home/u/a'), null);
  assert.match(pathIssue('rel/a'), /absolute/);
  assert.match(pathIssue(''), /absolute/);
  assert.match(pathIssue(42), /absolute/);
  assert.match(pathIssue('C:\\Work\\..\\x'), /\.\./);
  assert.match(pathIssue('\\\\host\\share\\a'), /UNC|device/);
  assert.match(pathIssue('//host/share'), /UNC|device/);
  assert.match(pathIssue('\\\\?\\C:\\x'), /UNC|device/);
});

test('insideRoots is lexical, case-insensitive and separator-blind', () => {
  assert.equal(insideRoots(['C:\\Work'], 'c:/work/sub/f.js'), true);
  assert.equal(insideRoots(['C:\\Work'], 'C:\\Work'), true);
  assert.equal(insideRoots(['C:\\Work'], 'C:\\Workshop\\f'), false);
  assert.equal(insideRoots([], 'C:\\Work\\f'), false);
});

test('ownerOfSession reads the namespace prefix only', () => {
  assert.equal(ownerOfSession('cli_aaa:1234'), 'cli_aaa');
  assert.equal(ownerOfSession('1234-5678'), null);
  assert.equal(ownerOfSession('foo:bar'), null);
});

test('ownerOfPath: a sole owner wins, revoked and unpaired ignored, tie is ambiguous', () => {
  assert.equal(ownerOfPath([A, B], 'C:\\Work\\Alpha\\x.js').client.id, 'cli_aaa');
  assert.equal(ownerOfPath([A, B], 'd:\\REPOS\\beta\\y').client.id, 'cli_bbb');
  assert.equal(ownerOfPath([A, B], 'E:\\none'), null);
  const gone = cl('cli_ccc', ['E:\\none'], { revokedTs: 5, paired: false });
  assert.equal(ownerOfPath([A, gone], 'E:\\none\\f'), null);
  const deadDeep = cl('cli_ddd', ['C:\\Work\\Alpha\\sub'], { revokedTs: 5, paired: false });
  assert.equal(ownerOfPath([A, deadDeep], 'C:\\Work\\Alpha\\sub\\f').client.id, 'cli_aaa', 'a revoked client cannot make a path ambiguous');
  const tie = cl('cli_eee', ['c:/work/alpha']);
  const r = ownerOfPath([A, tie], 'C:\\Work\\Alpha\\f');
  assert.deepEqual(r.ambiguous.sort(), ['cli_aaa', 'cli_eee']);
});

// Scan F8: a client declaring a root nested inside another live client's root
// must not capture path-routed reads and saves under that subtree.
test('ownerOfPath: a nested root on a second live client makes the path ambiguous', () => {
  const deep = cl('cli_ddd', ['C:\\Work\\Alpha\\sub']);
  const r = ownerOfPath([A, deep], 'C:\\Work\\Alpha\\sub\\f');
  assert.deepEqual(r?.ambiguous?.sort(), ['cli_aaa', 'cli_ddd']);
  assert.deepEqual(ownerOfPath([deep, A], 'c:/work/alpha/SUB'), { ambiguous: ['cli_ddd', 'cli_aaa'] }, 'order and case do not matter');
  assert.equal(ownerOfPath([A, deep], 'C:\\Work\\Alpha\\other\\f').client.id, 'cli_aaa', 'outside the nested root the outer client still owns it');
  const self = cl('cli_sss', ['C:\\Work', 'C:\\Work\\Alpha\\sub']);
  assert.equal(ownerOfPath([self], 'C:\\Work\\Alpha\\sub\\f').client.id, 'cli_sss', 'one client nesting its own roots is not ambiguous');
});

test('resolveTarget: a nested-root overlap refuses path-only routing 409 and an explicit clientId resolves it', () => {
  const deep = cl('cli_ddd', ['C:\\Work\\Alpha\\sub']);
  const r = resolveTarget({ clients: [A, deep], paths: ['C:\\Work\\Alpha\\sub\\secret.txt'] });
  assert.equal(r.refuse, 409); assert.match(r.reason, /cli_aaa/); assert.match(r.reason, /cli_ddd/); assert.match(r.reason, /clientId/);
  assert.equal(resolveTarget({ clients: [A, deep], clientId: 'cli_aaa', paths: ['C:\\Work\\Alpha\\sub\\secret.txt'] }).clientId, 'cli_aaa');
  assert.equal(resolveTarget({ clients: [A, deep], clientId: 'cli_ddd', paths: ['C:\\Work\\Alpha\\sub\\secret.txt'] }).clientId, 'cli_ddd');
});

test('resolveTarget: unowned path and unprefixed session are local', () => {
  assert.deepEqual(resolveTarget({ clients: [A], paths: ['E:\\x\\f'] }), { target: 'local' });
  assert.deepEqual(resolveTarget({ clients: [A], sessionId: 'plain-id' }), { target: 'local' });
  assert.deepEqual(resolveTarget({ clients: [], paths: [] }), { target: 'local' });
  assert.deepEqual(resolveTarget({ clients: [A], sessionId: 'plain-id', paths: ['C:\\Work\\Alpha\\f'] }), { target: 'local' }, 'a client-owned cwd does not move a server session');
  assert.deepEqual(resolveTarget({ clients: [A], sessionId: 'plain-id', paths: ['rel'] }), { target: 'local' }, 'the local branch validates its own cwd');
});

test('resolveTarget: a path inside the server box roots stays local even when a client root covers it', () => {
  const wide = cl('cli_www', ['C:\\']);
  const roots = ['c:/work/server-repo'];
  assert.deepEqual(resolveTarget({ clients: [wide], paths: ['C:\\Work\\server-repo\\CLAUDE.md'], localRoots: roots }), { target: 'local' });
  assert.deepEqual(resolveTarget({ clients: [A], paths: ['C:\\Work\\Alpha\\f'], localRoots: ['C:/Work/Alpha'] }), { target: 'local' }, 'same root on both sides');
  assert.equal(resolveTarget({ clients: [wide], paths: ['C:\\Other\\f'], localRoots: roots }).clientId, 'cli_www', 'outside the server roots the client still owns it');
  assert.equal(resolveTarget({ clients: [wide], clientId: 'cli_www', paths: ['C:\\Work\\server-repo\\f'], localRoots: roots }).clientId, 'cli_www', 'naming the client still reaches it');
  assert.equal(resolveTarget({ clients: [A, B], paths: ['C:\\Work\\Alpha\\f', 'D:\\repos\\beta\\f'], localRoots: ['C:/Work/Alpha'] }).refuse, 409, 'a server path and a client path in one request');
});

test('resolveTarget: owned path routes to the owner', () => {
  const r = resolveTarget({ clients: [A, B], paths: ['D:\\repos\\beta\\f'] });
  assert.equal(r.target, 'client'); assert.equal(r.clientId, 'cli_bbb'); assert.equal(r.client.name, 'box-cli_bbb');
});

test('resolveTarget: a malformed path is refused 400 only when a client is named; otherwise the local branch validates it', () => {
  for (const p of ['rel', 'C:\\Work\\Alpha\\..\\f', '\\\\h\\s\\f']) {
    assert.deepEqual(resolveTarget({ clients: [A], paths: [p] }), { target: 'local' }, p);
    assert.equal(resolveTarget({ clients: [A], clientId: 'cli_aaa', paths: [p] }).refuse, 400, p);
    assert.equal(resolveTarget({ clients: [A], sessionId: 'cli_aaa:s1', paths: [p] }).refuse, 400, p);
  }
});

test('resolveTarget: explicit clientId rules', () => {
  assert.equal(resolveTarget({ clients: [A], clientId: 'cli_zzz' }).refuse, 404);
  const unpaired = cl('cli_ccc', ['E:\\'], { paired: false, revokedTs: 1 });
  const u = resolveTarget({ clients: [unpaired], clientId: 'cli_ccc' });
  assert.equal(u.refuse, 409); assert.match(u.reason, /not paired/);
  const ok = resolveTarget({ clients: [A, B], clientId: 'cli_aaa', paths: ['C:\\Work\\Alpha\\f'] });
  assert.equal(ok.clientId, 'cli_aaa');
  const bad = resolveTarget({ clients: [A, B], clientId: 'cli_bbb', paths: ['C:\\Work\\Alpha\\f'] });
  assert.equal(bad.refuse, 403); assert.match(bad.reason, /path not owned by client cli_bbb/);
  const tie = cl('cli_eee', ['c:/work/alpha']);
  assert.equal(resolveTarget({ clients: [A, tie], clientId: 'cli_eee', paths: ['C:\\Work\\Alpha\\f'] }).clientId, 'cli_eee');
});

test('resolveTarget: namespaced session goes to its client', () => {
  assert.equal(resolveTarget({ clients: [A], sessionId: 'cli_aaa:s1' }).clientId, 'cli_aaa');
  assert.equal(resolveTarget({ clients: [A], sessionId: 'cli_nope:s1' }).refuse, 409);
  const unpaired = cl('cli_ccc', [], { paired: false });
  assert.equal(resolveTarget({ clients: [unpaired], sessionId: 'cli_ccc:s1' }).refuse, 409);
  assert.equal(resolveTarget({ clients: [A], sessionId: 'cli_aaa:s1', paths: ['C:\\Work\\Alpha'] }).clientId, 'cli_aaa');
  assert.equal(resolveTarget({ clients: [A], sessionId: 'cli_aaa:s1', paths: ['E:\\other'] }).refuse, 403);
});

test('resolveTarget: ambiguous path names both clients', () => {
  const tie = cl('cli_eee', ['c:/work/alpha']);
  const r = resolveTarget({ clients: [A, tie], paths: ['C:\\Work\\Alpha\\f'] });
  assert.equal(r.refuse, 409); assert.match(r.reason, /cli_aaa/); assert.match(r.reason, /cli_eee/);
});
