// server/test/fixtures/git-repo-fixture.js
// A real repository with an upstream, one file of each drift status:
// a.txt uncommitted, c.txt untracked, dir/b.txt ahead, d.txt behind, plus a
// binary file and a tracked .env (for the secret refusal).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'pipe' }).toString();

export function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tree-'));
  const remote = path.join(base, 'remote.git');
  git(base, 'init', '--bare', remote);
  const work = path.join(base, 'work');
  git(base, 'clone', remote, work);
  fs.mkdirSync(path.join(work, 'dir'));
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(work, 'dir', 'b.txt'), 'bee\n');
  fs.writeFileSync(path.join(work, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(work, '.env'), 'SECRET=x\n');
  git(work, 'add', '.'); git(work, 'commit', '-m', 'init'); git(work, 'push', '-u', 'origin', 'main');
  const other = path.join(base, 'other');
  git(base, 'clone', remote, other);
  fs.writeFileSync(path.join(other, 'd.txt'), 'dee\n'); git(other, 'add', '.'); git(other, 'commit', '-m', 'remote side'); git(other, 'push');
  git(work, 'fetch');
  fs.writeFileSync(path.join(work, 'dir', 'b.txt'), 'bee two\n'); git(work, 'commit', '-am', 'local side');
  fs.writeFileSync(path.join(work, 'a.txt'), 'one changed\n');
  fs.writeFileSync(path.join(work, 'c.txt'), 'new\n');
  return { base, work };
}
