// affected-tests: always
// CI rule (program K4): every event kind declared as an opener has a closer,
// and every opener call site in server/ uses a declared kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OBLIGATION_KINDS } from '../lib/kernel/obligations.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === 'test' ? [] : walk(path.join(d, e.name))) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []); }

test('every opened kind is declared and closable', () => {
  const opened = new Set();
  for (const f of walk(ROOT)) for (const m of fs.readFileSync(f, 'utf8').matchAll(/\.open\(\{\s*kind:\s*'([a-z.-]+)'/g)) opened.add(m[1]);
  for (const k of opened) { assert.ok(OBLIGATION_KINDS[k], `opener uses undeclared kind ${k}`); assert.ok(OBLIGATION_KINDS[k].closers.length, `${k} has no closer`); }
  for (const [k, v] of Object.entries(OBLIGATION_KINDS)) assert.ok(v.closers.length, `${k} has no closer`);
});
