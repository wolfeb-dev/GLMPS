import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deferredRefsFor, relevantFilesFor, sanitizeQuery, parseGraphifyFiles } from '../lib/orchestration/ticket-enrich.js';

test('deferredRefsFor finds held same-project tickets with overlapping files', () => {
  const items = [
    { id: 'glmps-1', project: 'p', state: 'held', relevantFiles: ['a.js', 'b.js'] },
    { id: 'glmps-2', project: 'p', state: 'queued', relevantFiles: ['a.js'] },   // not held
    { id: 'glmps-3', project: 'q', state: 'held', relevantFiles: ['a.js'] },     // other project
    { id: 'glmps-4', project: 'p', state: 'held', relevantFiles: ['z.js'] },     // no overlap
  ];
  const item = { id: 'glmps-9', project: 'p', relevantFiles: ['a.js', 'c.js'] };
  assert.deepEqual(deferredRefsFor(items, item), ['glmps-1']);
  assert.deepEqual(deferredRefsFor(items, { ...item, relevantFiles: [] }), []);
});

test('sanitizeQuery strips shell-dangerous chars and caps length', () => {
  assert.equal(sanitizeQuery('fix $(rm -rf) & pill; row'), 'fix rm -rf pill row');
  assert.equal(sanitizeQuery('x'.repeat(500)).length, 200);
});

test('sanitizeQuery strips every shell/cmd metacharacter', () => {
  const evil = 'a`b|c<d>e"f\'g%h^i\nj\\k;l&m$(n)o{p}q[r]s!t~u#v=w+x,y:z@';
  const out = sanitizeQuery(evil);
  for (const ch of ['`','|','<','>','"','\'','%','^','\\',';','&','$','(',')','{','}','[',']','!','~','#','=','+',',',':','@','\n']) {
    assert.ok(!out.includes(ch), `metacharacter ${JSON.stringify(ch)} must be stripped`);
  }
  assert.match(out, /^[\w\s./-]*$/);
});

test('parseGraphifyFiles extracts unique src= paths', () => {
  const out = 'NODE a [src=web/board.js loc=L1]\nNODE b [src=web/board.js loc=L2]\nNODE c [src=server/x.js loc=L9]';
  assert.deepEqual(parseGraphifyFiles(out), ['web/board.js', 'server/x.js']);
});

test('relevantFilesFor returns [] on exec failure and parses on success', async () => {
  assert.deepEqual(await relevantFilesFor({ repo: 'r', title: 't', exec: () => { throw new Error('no graphify'); } }), []);
  assert.deepEqual(await relevantFilesFor({ repo: 'r', title: 't', exec: async () => { throw new Error('no graphify'); } }), []);
  const files = await relevantFilesFor({ repo: 'r', title: 't', description: 'd', exec: () => 'NODE a [src=web/a.js loc=L1]' });
  assert.deepEqual(files, ['web/a.js']);
});
