// apps/shell/test/gitops-allow.test.js
// The shell's allowlist for the git, gh and test operations the service kernel
// queues for the merge queue. The kernel is not trusted to stay inside the
// merge queue's own needs, so everything is checked again here, in the
// operator's session, before any process starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGitopsOp, normPath, insideRoot } from '../src/lib/gitops-allow.js';

const roots = { repos: ['D:\\glmps', 'D:\\glmps-2.0'], worktrees: 'C:\\Users\\op\\.glmps\\runner\\worktrees' };
const WT = 'C:\\Users\\op\\.glmps\\runner\\worktrees';
const MQ = `${WT}\\merge-queue\\card-1`;
const ok = (op) => validateGitopsOp(op, { roots, worktreesDir: WT });
const refused = (op, re) => {
  const v = ok(op);
  assert.equal(v.ok, false, `expected refusal: ${JSON.stringify(op)}`);
  if (re) assert.match(v.reason, re);
};

test('paths are compared after normalizing case, slashes and dot segments', () => {
  assert.equal(normPath('D:\\GLMPS\\.\\x\\..\\y\\'), 'd:/glmps/y');
  assert.equal(insideRoot('d:/GLMPS/sub', 'D:\\glmps'), true);
  assert.equal(insideRoot('D:\\glmps-evil', 'D:\\glmps'), false);
  assert.equal(insideRoot('D:\\glmps\\..\\secrets', 'D:\\glmps'), false);
  assert.equal(insideRoot('relative/path', 'D:\\glmps'), false);
});

test('gh: pr view and pr merge in the exact merge-queue shapes pass', () => {
  const view = ok({ kind: 'gh', args: ['pr', 'view', '22', '-R', 'wolfeb-dev/glmps-2.0', '--json', 'state,headRefOid,mergeable,baseRefName,mergeCommit'] });
  assert.equal(view.ok, true);
  assert.equal(view.recipe.file, 'gh');
  assert.equal(ok({ kind: 'gh', args: ['pr', 'view', '7', '-R', 'wolfeb-dev/glmps-2.0', '--json', 'baseRefName,headRefName,headRefOid,state,isCrossRepository'] }).ok, true);
  const merge = ok({ kind: 'gh', args: ['pr', 'merge', '22', '-R', 'wolfeb-dev/glmps-2.0', '--merge', '--match-head-commit', 'a'.repeat(40)] });
  assert.equal(merge.ok, true);
  assert.deepEqual(merge.recipe.args, ['pr', 'merge', '22', '-R', 'wolfeb-dev/glmps-2.0', '--merge', '--match-head-commit', 'a'.repeat(40)]);
});

test('gh: --admin, --auto, other flags and subcommands, a missing head pin and the public repo are refused', () => {
  const m = ['pr', 'merge', '22', '-R', 'wolfeb-dev/glmps-2.0', '--merge', '--match-head-commit', 'a'.repeat(40)];
  refused({ kind: 'gh', args: [...m, '--admin'] });
  refused({ kind: 'gh', args: [...m, '--auto'] });
  refused({ kind: 'gh', args: [...m, '--delete-branch'] });
  refused({ kind: 'gh', args: ['pr', 'merge', '22', '-R', 'wolfeb-dev/glmps-2.0', '--merge'] }, /head/i);
  refused({ kind: 'gh', args: ['pr', 'merge', '22', '-R', 'wolfeb-dev/glmps-2.0', '--squash', '--match-head-commit', 'a'.repeat(40)] });
  refused({ kind: 'gh', args: ['pr', 'merge', '22', '-R', 'wolfeb-dev/glmps-2.0', '--merge', '--match-head-commit', 'main'] }, /sha/i);
  refused({ kind: 'gh', args: ['pr', 'close', '22', '-R', 'wolfeb-dev/glmps-2.0'] });
  refused({ kind: 'gh', args: ['api', 'repos/x/y/merges'] });
  refused({ kind: 'gh', args: ['auth', 'token'] });
  refused({ kind: 'gh', args: ['pr', 'view', '22', '-R', 'wolfeb-dev/glmps-2.0', '--json', 'state', '--web'] });
  refused({ kind: 'gh', args: ['pr', 'view', '22', '-R', 'wolfeb-dev/glmps', '--json', 'state'] }, /public/i);
  refused({ kind: 'gh', args: ['pr', 'view', '22', '-R', 'WOLFEB-DEV/GLMPS', '--json', 'state'] }, /public/i);
  refused({ kind: 'gh', args: ['pr', 'view', '22;x', '-R', 'wolfeb-dev/glmps-2.0', '--json', 'state'] });
  refused({ kind: 'gh', args: ['pr', 'view', '22', '-R', 'not a repo', '--json', 'state'] });
});

// glmps-2-0-73: the kernel's own Actions minutes calls, taken from the kernel
// module itself, so the two files cannot drift apart unnoticed again (the
// first deploy failed live on a gh call this allowlist refused).
test('gh api: the kernel Actions minutes calls pass exactly as the kernel builds them', async () => {
  const { ghArgs } = await import('../../../server/lib/observability/actions-minutes.js');
  for (const args of [ghArgs.repos(), ghArgs.runs('wolfeb-dev/glmps-2.0', '2026-10'), ghArgs.runsLegacy('wolfeb-dev/glmps-2.0', '2026-10'), ghArgs.jobs('wolfeb-dev/glmps-2.0', 18834567890)]) {
    const v = ok({ kind: 'gh', args });
    assert.equal(v.ok, true, `${args.join(' ')}: ${v.reason}`);
    assert.deepEqual(v.recipe.args, args);
  }
});

test('gh api: any other path, method, flag or filter is refused', async () => {
  const { ghArgs } = await import('../../../server/lib/observability/actions-minutes.js');
  const runs = ghArgs.runs('wolfeb-dev/glmps-2.0', '2026-10');
  refused({ kind: 'gh', args: ['api', 'repos/x/y/merges'] });
  refused({ kind: 'gh', args: [...runs, '-X', 'DELETE'] });
  refused({ kind: 'gh', args: ['api', '-X', 'POST', runs[2], '--jq', runs[4]] });
  refused({ kind: 'gh', args: ['api', '--paginate', runs[2], '--jq', '.'] }, /filter/);
  refused({ kind: 'gh', args: ['api', '--paginate', 'repos/wolfeb-dev/glmps-2.0/actions/runs/1/rerun', '--jq', runs[4]] }, /path/);
  refused({ kind: 'gh', args: ['api', '--paginate', 'repos/wolfeb-dev/glmps-2.0/actions/secrets', '--jq', runs[4]] }, /path/);
  refused({ kind: 'gh', args: ['api', '--paginate', 'user/repos?per_page=100', '--jq', '.[] | select(.private) | .full_name'] }, /path/);
  refused({ kind: 'gh', args: ['api', '--paginate', 'repos/a b/c/actions/runs?per_page=100&created=%3E%3D2026-10-01', '--jq', runs[4]] }, /path/);
});

// glmps-2-0-155: the QA-trends CI sampler's reads, taken from the kernel module.
test('gh run and issue: the QA-trends sampler reads pass exactly as the kernel builds them', async () => {
  const { qaGhArgs } = await import('../../../server/lib/observability/qa-trends-store.js');
  const repo = 'wolfeb-dev/glmps-2.0';
  for (const args of [qaGhArgs.runs(repo, 1), qaGhArgs.runs(repo, 30), qaGhArgs.jobs(repo, 42262455402), qaGhArgs.jobLog(repo, 128045630256), qaGhArgs.issues(repo)]) {
    const v = ok({ kind: 'gh', args });
    assert.equal(v.ok, true, `${args.join(' ')}: ${v.reason}`);
    assert.deepEqual(v.recipe.args, args);
  }
});

test('gh run and issue: any other shape is refused', async () => {
  const { qaGhArgs } = await import('../../../server/lib/observability/qa-trends-store.js');
  const repo = 'wolfeb-dev/glmps-2.0';
  const runs = qaGhArgs.runs(repo, 1);
  refused({ kind: 'gh', args: ['run', 'rerun', '42', '-R', repo] });
  refused({ kind: 'gh', args: ['run', 'cancel', '42', '-R', repo] });
  refused({ kind: 'gh', args: ['run', 'download', '42', '-R', repo] });
  refused({ kind: 'gh', args: ['run', 'list', '--workflow=ci.yml', '-L', '1', '--json', runs[8]] }, /-R/);
  refused({ kind: 'gh', args: runs.map((a) => (a === '1' ? '500' : a)) });
  refused({ kind: 'gh', args: runs.map((a) => (a === '--workflow=ci.yml' ? '--workflow=deploy.yml' : a)) });
  refused({ kind: 'gh', args: runs.map((a) => (a.startsWith('databaseId') ? 'databaseId,url,jobs' : a)) });
  refused({ kind: 'gh', args: [...runs, '--web'] });
  refused({ kind: 'gh', args: qaGhArgs.jobs(repo, '42;x') });
  refused({ kind: 'gh', args: [...qaGhArgs.jobLog(repo, 7), '--log-failed'] });
  refused({ kind: 'gh', args: ['run', 'view', '--job', '7', '-R', 'not a repo', '--log'] });
  refused({ kind: 'gh', args: ['issue', 'create', '-R', repo, '--title', 'x'] });
  refused({ kind: 'gh', args: ['issue', 'list', '-R', repo, '--state', 'all', '--json', 'number'] });
  refused({ kind: 'gh', args: ['issue', 'list', '-R', repo, '--state', 'open', '--json', 'number,body'] });
});

test('git: the read and plumbing subcommands the merge queue uses pass, with -C and -c prefixes', () => {
  const cwd = 'D:\\glmps';
  for (const args of [
    ['fetch', '-q', 'origin'],
    ['rev-parse', 'HEAD'],
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    ['rev-parse', 'origin/glmps2/main'],
    ['diff', 'origin/glmps2/main...origin/feat/x'],
    ['diff', '--name-only', '--diff-filter=U'],
    ['status', '--porcelain'],
    ['log', '--oneline', '-n', '5'],
    ['show', '--stat', 'HEAD'],
    ['remote', 'get-url', 'origin'],
    ['config', '--get', 'remote.origin.url'],
    ['worktree', 'prune'],
    ['merge', '--abort'],
  ]) {
    const v = ok({ kind: 'git', cwd, args });
    assert.equal(v.ok, true, `${args.join(' ')}: ${v.reason}`);
    assert.equal(v.recipe.file, 'git');
    assert.equal(v.recipe.cwd, cwd);
  }
  const merge = ok({ kind: 'git', cwd: MQ, args: ['-c', 'user.name=merge-queue', '-c', 'user.email=merge-queue@localhost', '-c', 'commit.gpgsign=false', 'merge', '--no-ff', '-m', 'merge-queue test merge of glmps2/main', 'origin/glmps2/main'] });
  assert.equal(merge.ok, true, merge.reason);
  assert.equal(ok({ kind: 'git', cwd, args: ['-C', 'D:\\glmps-2.0', 'fetch', '-q', 'origin'] }).ok, true);
});

test('git: worktree add and remove only touch directories under the worktrees root', () => {
  const cwd = 'D:\\glmps';
  assert.equal(ok({ kind: 'git', cwd, args: ['worktree', 'add', '--detach', MQ, 'origin/feat/x'] }).ok, true);
  assert.equal(ok({ kind: 'git', cwd, args: ['worktree', 'remove', '--force', MQ] }).ok, true);
  refused({ kind: 'git', cwd, args: ['worktree', 'add', '--detach', 'D:\\elsewhere\\wt', 'origin/feat/x'] }, /root/i);
  refused({ kind: 'git', cwd, args: ['worktree', 'remove', '--force', 'D:\\glmps'] }, /root/i);
  refused({ kind: 'git', cwd, args: ['worktree', 'remove', '--force', `${WT}\\..\\..\\x`] }, /root/i);
  refused({ kind: 'git', cwd, args: ['worktree', 'add', 'relative', 'origin/x'] }, /root/i);
  refused({ kind: 'git', cwd, args: ['worktree', 'lock', MQ] });
});

test('git: push, reset, clean, checkout, branch -D, rebase and every other subcommand are refused', () => {
  const cwd = 'D:\\glmps';
  for (const args of [
    ['push', 'origin', 'main'], ['push', '--force'], ['reset', '--hard', 'HEAD'], ['clean', '-fd'], ['checkout', '--', 'file.js'],
    ['checkout', 'main'], ['branch', '-D', 'main'], ['rebase', 'main'], ['commit', '-am', 'x'], ['add', '.'], ['stash'], ['gc'],
    ['update-ref', '-d', 'refs/heads/main'], ['tag', '-d', 'v1'], ['remote', 'add', 'x', 'url'], ['remote', 'set-url', 'origin', 'x'],
    ['config', 'core.hooksPath', 'x'], ['config', '--global', 'user.name', 'x'], ['config', '--unset', 'x'], ['cherry-pick', 'abc'],
  ]) refused({ kind: 'git', cwd, args });
});

test('git: flags that execute programs or write files, and unlisted -c settings, are refused', () => {
  const cwd = 'D:\\glmps';
  for (const args of [
    ['fetch', '--upload-pack=calc', 'origin'], ['fetch', 'https://evil.example/x.git'], ['fetch', '-q', 'upstream'],
    ['diff', '--output=C:\\x.txt', 'HEAD'], ['log', '--output=x'], ['diff', '--no-index', 'a', 'b'], ['diff', '--ext-diff', 'HEAD'],
    ['show', '--textconv', 'HEAD'], ['merge', '-s', 'ours', 'x'], ['merge', '-X', 'theirs', 'x'], ['merge', 'x', '-m'],
    ['-c', 'core.sshCommand=calc', 'fetch', 'origin'], ['-c', 'core.hooksPath=x', 'merge', 'x'], ['-c', 'alias.x=!calc', 'status'],
    ['--exec-path=x', 'status'], ['--git-dir=x', 'status'], ['--work-tree=x', 'status'],
    ['rev-parse', '--git-dir', 'x;calc'], ['rev-parse', 'a b'], ['rev-parse', '$(calc)'], ['rev-parse', 'a`b'],
  ]) refused({ kind: 'git', cwd, args });
});

test('git: cwd and -C must be inside an allowed root', () => {
  refused({ kind: 'git', cwd: 'C:\\Windows', args: ['status'] }, /root/i);
  refused({ kind: 'git', args: ['status'] }, /cwd/i);
  refused({ kind: 'git', cwd: 'D:\\glmps', args: ['-C', 'C:\\Users\\op', 'status'] }, /root/i);
  refused({ kind: 'git', cwd: 'D:\\glmps\\..\\Windows', args: ['status'] }, /root/i);
  assert.equal(ok({ kind: 'git', cwd: 'd:/GLMPS', args: ['status'] }).ok, true);
  assert.equal(ok({ kind: 'git', cwd: MQ, args: ['status'] }).ok, true);
  assert.equal(validateGitopsOp({ kind: 'git', cwd: 'D:\\glmps', args: ['status'] }, { roots: { repos: [], worktrees: '' } }).ok, false);
  assert.equal(validateGitopsOp({ kind: 'git', cwd: 'D:\\glmps', args: ['status'] }, {}).ok, false);
});

test('test: only a package test command, only inside the merge-queue worktrees dir', () => {
  const v = ok({ kind: 'test', cwd: MQ, command: 'npm test', timeoutMs: 1800000 });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.recipe.cwd, MQ);
  assert.equal(v.recipe.command, 'npm test');
  assert.equal(v.recipe.timeoutMs, 1800000);
  for (const command of ['npm run test', 'pnpm test', 'yarn test', 'npm test -- --reporter=dot', 'node --test --env-file=test.env test/a.test.js']) {
    assert.equal(ok({ kind: 'test', cwd: MQ, command }).ok, true, command);
  }
  refused({ kind: 'test', cwd: 'D:\\glmps', command: 'npm test' }, /merge-queue/i);
  refused({ kind: 'test', cwd: WT, command: 'npm test' }, /merge-queue/i);
  refused({ kind: 'test', cwd: `${WT}\\merge-queue\\..\\..\\x`, command: 'npm test' }, /merge-queue/i);
  refused({ kind: 'test', cwd: `${WT}\\other\\x`, command: 'npm test' }, /merge-queue/i);
  for (const command of ['npm test && calc', 'npm test; calc', 'npm test | calc', 'npm test > x', 'npm test `calc`', 'npm test $(calc)', 'calc', 'npm install', 'npm run build -- x', 'npm run build x', 'npm run lint -- --fix', 'npm run deploy', 'npm run Build', 'npm run build && calc', 'node evil.js', 'npm test\ncalc', 'npm test "x"', '', 5, null]) {
    refused({ kind: 'test', cwd: MQ, command }, /command/i);
  }
});

test('test: npm run build and npm run lint are accepted exactly, nothing else under npm run', () => {
  for (const command of ['npm run build', 'npm run lint']) {
    const v = ok({ kind: 'test', cwd: MQ, command });
    assert.equal(v.ok, true, v.reason);
    assert.equal(v.recipe.command, command);
  }
  for (const command of ['npm run build ', ' npm run build', 'npm run build -- x', 'npm run deploy', 'npm run start', 'pnpm run build', 'yarn build']) {
    refused({ kind: 'test', cwd: MQ, command }, /command/i);
  }
  refused({ kind: 'test', cwd: WT, command: 'npm run build' }, /merge-queue/i);
});

test('an unknown kind, a missing args array and non-string args are refused', () => {
  refused({ kind: 'sh', args: ['-c', 'calc'] });
  refused({ kind: 'git', cwd: 'D:\\glmps' });
  refused({ kind: 'git', cwd: 'D:\\glmps', args: ['status', 5] });
  refused(null);
});

test('timeoutMs is clamped to a sane range', () => {
  const v = ok({ kind: 'git', cwd: 'D:\\glmps', args: ['status'], timeoutMs: 99999999999 });
  assert.ok(v.recipe.timeoutMs <= 2 * 60 * 60 * 1000);
  assert.ok(ok({ kind: 'git', cwd: 'D:\\glmps', args: ['status'] }).recipe.timeoutMs >= 1000);
});

const STATE = 'C:\\Users\\op\\.glmps';
const RV = `${WT}\\glmps-2.0\\glmps-2-0-52-review-r1`;
const REVIEW = {
  kind: 'review', cwd: RV, model: 'sonnet', timeoutMs: 3600000,
  settings: `${STATE}\\role-settings\\reviewer-glmps-2-0-52-review-r1.json`,
  promptFile: `${STATE}\\runner\\glmps-2-0-52-review-r1.prompt.md`,
};
const rv = (over) => validateGitopsOp({ ...REVIEW, ...over }, { roots, stateDir: STATE, worktreesDir: WT });
const rvRefused = (over, re) => {
  const v = rv(over);
  assert.equal(v.ok, false, `expected refusal: ${JSON.stringify(over)}`);
  if (re) assert.match(v.reason, re);
};

test('review: the exact headless reviewer shape passes and the recipe carries only the fixed flags', () => {
  const v = rv({});
  assert.equal(v.ok, true, v.reason);
  assert.deepEqual(v.recipe.args, ['-p', '--model', 'sonnet', '--settings', REVIEW.settings, '--permission-mode', 'auto', '--fallback-model', 'haiku']);
  assert.equal(v.recipe.kind, 'review');
  assert.equal(v.recipe.cwd, RV);
  assert.equal(v.recipe.promptFile, REVIEW.promptFile);
  assert.equal(v.recipe.timeoutMs, 3600000);
  assert.equal(rv({ cwd: `${WT}\\glmps-2.0\\glmps-2-0-52-repair-r2`, model: 'claude-opus-4-5' }).ok, true);
});

// glmps-2-0-runtime-126: every git read and the launch the batched reviewer
// loop (server/lib/orchestration/batch-review.js) sends through this shell.
test('review: the batched reviewer git calls and launch shape pass', () => {
  const a = 'a'.repeat(40); const b = 'b'.repeat(40);
  const dir = `${WT}\\glmps-2.0-runtime\\batch-wolfeb-dev_glmps_glmps2_main-review-r1`;
  for (const args of [
    ['fetch', '-q', 'origin'],
    ['rev-parse', 'origin/glmps2/main'],
    ['log', '--first-parent', '--format=%H', `${a}..${b}`],
    ['diff', `${a}..${b}`],
    ['worktree', 'add', '--detach', dir, b],
    ['worktree', 'remove', '--force', dir],
    ['worktree', 'prune'],
  ]) {
    const v = ok({ kind: 'git', cwd: 'D:\\glmps', args });
    assert.equal(v.ok, true, `${args.join(' ')}: ${v.reason}`);
  }
  const job = 'batch-wolfeb-dev_glmps_glmps2_main-review-r1';
  assert.equal(rv({ cwd: dir, settings: `${STATE}\\role-settings\\reviewer-${job}.json`, promptFile: `${STATE}\\runner\\${job}.prompt.md` }).ok, true);
});

test('review: cwd must be a review or repair worktree under the worktrees dir', () => {
  rvRefused({ cwd: 'D:\\glmps' }, /cwd/i);
  rvRefused({ cwd: WT }, /cwd/i);
  rvRefused({ cwd: `${WT}\\glmps-2.0\\glmps-2-0-52` }, /review|repair/i);
  rvRefused({ cwd: `${WT}\\merge-queue\\glmps-2-0-52` }, /review|repair/i);
  rvRefused({ cwd: `${WT}\\glmps-2.0\\x-review-r1\\..\\..\\..\\..\\evil` }, /cwd/i);
  rvRefused({ cwd: `${WT}\\..\\elsewhere\\x-review-r1` }, /cwd/i);
  rvRefused({ cwd: undefined }, /cwd/i);
});

test('review: settings must be a reviewer file in the state dir role-settings dir', () => {
  rvRefused({ settings: `${STATE}\\role-settings\\worker-x.json` }, /settings/i);
  rvRefused({ settings: `${STATE}\\role-settings\\reviewer-x.txt` }, /settings/i);
  rvRefused({ settings: `${STATE}\\role-settings\\sub\\reviewer-x.json` }, /settings/i);
  rvRefused({ settings: `${STATE}\\role-settings\\..\\launch-token` }, /settings/i);
  rvRefused({ settings: 'C:\\evil\\role-settings\\reviewer-x.json' }, /settings/i);
  rvRefused({ settings: '{"hooks":{}}' }, /settings/i);
  rvRefused({ settings: undefined }, /settings/i);
});

test('review: the prompt file must be a runner prompt in the state dir', () => {
  rvRefused({ promptFile: `${STATE}\\launch-token` }, /prompt/i);
  rvRefused({ promptFile: `${STATE}\\runner\\x.txt` }, /prompt/i);
  rvRefused({ promptFile: `${STATE}\\runner\\sub\\x.prompt.md` }, /prompt/i);
  rvRefused({ promptFile: 'C:\\evil\\runner\\x.prompt.md' }, /prompt/i);
  rvRefused({ promptFile: undefined }, /prompt/i);
});

test('review: the model must be a short alias and nothing else reaches the command line', () => {
  for (const model of ['--dangerously-skip-permissions', 'sonnet --x', 'opus;calc', '', 'a'.repeat(80), 'x y', '-p', 5, undefined]) rvRefused({ model }, /model/i);
  assert.equal(rv({ model: 'opus' }).ok, true);
  const extra = rv({ args: ['--dangerously-skip-permissions'], command: 'calc' });
  assert.equal(extra.ok, true);
  assert.deepEqual(extra.recipe.args.filter((a) => /dangerous|calc/.test(a)), []);
});

test('review: with no state dir known the shell refuses', () => {
  const v = validateGitopsOp(REVIEW, { roots, worktreesDir: WT });
  assert.equal(v.ok, false);
  assert.match(v.reason, /state dir/i);
});

test('the worktrees root is the shell\'s own: a record that lies about roots.worktrees is refused for every kind', () => {
  const evil = 'C:\\evil\\worktrees';
  const lying = { repos: roots.repos, worktrees: evil };
  const v = (op, extra = {}) => validateGitopsOp(op, { roots: lying, stateDir: STATE, worktreesDir: WT, ...extra });
  assert.equal(v({ kind: 'git', cwd: `${evil}\\p\\x`, args: ['status'] }).ok, false, 'git cwd under the claimed root');
  assert.equal(v({ kind: 'git', cwd: 'D:\\glmps', args: ['worktree', 'add', '--detach', `${evil}\\p\\x`, 'origin/main'] }).ok, false, 'worktree add under the claimed root');
  assert.equal(v({ kind: 'git', cwd: 'D:\\glmps', args: ['worktree', 'remove', '--force', `${evil}\\p\\x`] }).ok, false, 'worktree remove under the claimed root');
  assert.equal(v({ kind: 'test', cwd: `${evil}\\merge-queue\\c1`, command: 'npm test' }).ok, false, 'test cwd under the claimed root');
  assert.equal(v({ ...REVIEW, cwd: `${evil}\\p\\c-review-r1` }).ok, false, 'review cwd under the claimed root');
  assert.equal(v({ kind: 'git', cwd: 'D:\\glmps', args: ['worktree', 'add', '--detach', `${WT}\\p\\x`, 'origin/main'] }).ok, true, 'the shell\'s own root still works');
  assert.equal(v({ ...REVIEW }).ok, true);
});

test('with no worktrees root of its own the shell refuses every worktree-dependent op and still allows repo-rooted git', () => {
  const none = (op) => validateGitopsOp(op, { roots, stateDir: STATE });
  assert.equal(none({ kind: 'git', cwd: `${WT}\\p\\x`, args: ['status'] }).ok, false);
  assert.equal(none({ kind: 'test', cwd: MQ, command: 'npm test' }).ok, false);
  assert.equal(none(REVIEW).ok, false);
  assert.equal(none({ kind: 'git', cwd: 'D:\\glmps', args: ['status'] }).ok, true);
});

// Unattended reliability T6: a secondary card runs headless (`claude -p`) in its own runner worktree.
const SID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const CW = `${WT}\\glmps-2.0\\glmps-2-0-81`;
const CARD = {
  kind: 'card', cwd: CW, sessionId: SID, resume: false, timeoutMs: 1800000,
  settings: `${STATE}\\role-settings\\worker-glmps-2-0-81.json`,
  promptFile: `${STATE}\\runner\\glmps-2-0-81.prompt.md`,
};
const cd = (over) => validateGitopsOp({ ...CARD, ...over }, { roots, stateDir: STATE, worktreesDir: WT });
const cdRefused = (over, re) => {
  const v = cd(over);
  assert.equal(v.ok, false, `expected refusal: ${JSON.stringify(over)}`);
  if (re) assert.match(v.reason, re);
};

test('card: a fresh headless card runs under its own session id with worker settings and fixed flags', () => {
  const v = cd({});
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.recipe.kind, 'card');
  assert.deepEqual(v.recipe.args, ['-p', '--settings', CARD.settings, '--permission-mode', 'auto', '--session-id', SID, '--fallback-model', 'sonnet,haiku']);
  assert.equal(v.recipe.cwd, CW);
  assert.equal(v.recipe.promptFile, CARD.promptFile);
  assert.equal(v.recipe.timeoutMs, 1800000);
});

test('card: a resume continues the recorded session, and a model alias is optional', () => {
  const v = cd({ resume: true, model: 'sonnet' });
  assert.equal(v.ok, true, v.reason);
  assert.deepEqual(v.recipe.args, ['-p', '--settings', CARD.settings, '--permission-mode', 'auto', '--resume', SID, '--model', 'sonnet', '--fallback-model', 'haiku']);
  for (const model of ['--dangerously-skip-permissions', 'opus;calc', 'x y', '-p', 5]) cdRefused({ model }, /model/i);
});

test('card: the last model in the Claude fallback order gets no fallback flag (card glmps-2-0-164)', () => {
  const v = cd({ model: 'haiku' });
  assert.equal(v.ok, true, v.reason);
  assert.ok(!v.recipe.args.includes('--fallback-model'), v.recipe.args.join(' '));
});

test('card: cwd must be a card worktree under the worktrees root, not a review, repair or merge-queue checkout', () => {
  cdRefused({ cwd: 'D:\\glmps' }, /cwd/i);
  cdRefused({ cwd: WT }, /cwd/i);
  cdRefused({ cwd: `${WT}\\glmps-2.0` }, /card worktree/i);
  cdRefused({ cwd: `${WT}\\glmps-2.0\\glmps-2-0-81\\sub` }, /card worktree/i);
  cdRefused({ cwd: `${WT}\\glmps-2.0\\glmps-2-0-52-review-r1` }, /card worktree/i);
  cdRefused({ cwd: `${WT}\\glmps-2.0\\glmps-2-0-52-repair-r2` }, /card worktree/i);
  cdRefused({ cwd: `${WT}\\merge-queue\\glmps-2-0-52` }, /card worktree/i);
  cdRefused({ cwd: `${WT}\\glmps-2.0\\x\\..\\..\\..\\..\\evil` }, /cwd/i);
  cdRefused({ cwd: undefined }, /cwd/i);
});

test('card: settings must be a worker file and the prompt a runner prompt, both in the state dir', () => {
  cdRefused({ settings: `${STATE}\\role-settings\\reviewer-x.json` }, /settings/i);
  cdRefused({ settings: `${STATE}\\role-settings\\..\\launch-token` }, /settings/i);
  cdRefused({ settings: 'C:\\evil\\role-settings\\worker-x.json' }, /settings/i);
  cdRefused({ promptFile: `${STATE}\\launch-token` }, /prompt/i);
  cdRefused({ promptFile: 'C:\\evil\\runner\\x.prompt.md' }, /prompt/i);
  assert.match(validateGitopsOp(CARD, { roots, worktreesDir: WT }).reason, /state dir/i);
});

test('card: the session id must be a UUID, resume a boolean, and nothing else reaches the command line', () => {
  for (const sessionId of ['', 'not-a-uuid', `${SID} --x`, `${SID};calc`, undefined, 5]) cdRefused({ sessionId }, /session id/i);
  for (const resume of ['yes', 1, null]) cdRefused({ resume }, /resume/i);
  const extra = cd({ args: ['--dangerously-skip-permissions'], command: 'calc' });
  assert.equal(extra.ok, true);
  assert.deepEqual(extra.recipe.args.filter((a) => /dangerous|calc/.test(a)), []);
});

test('card: the timeout defaults to the card default and is capped at 24 hours', () => {
  assert.equal(cd({ timeoutMs: undefined }).recipe.timeoutMs, 30 * 60 * 1000);
  assert.equal(cd({ timeoutMs: 8 * 3600000 }).recipe.timeoutMs, 8 * 3600000);
  assert.equal(cd({ timeoutMs: 99 * 3600000 }).recipe.timeoutMs, 24 * 3600000);
});

// Card glmps-2-0-162: a non-Claude vendor card (agy, codex, grok) in a card worktree.
const VC = {
  kind: 'vendor-card', vendor: 'gemini', model: 'Gemini 3.8 Flash (High)', cwd: CW,
  promptFile: `${STATE}\\runner\\glmps-2-0-81.prompt.md`, branch: 'card/glmps-2-0-81', base: 'glmps2/main',
  cardId: 'glmps-2-0-81', title: 'Fix the thing', timeoutMs: 600000,
};
const vc = (over) => validateGitopsOp({ ...VC, ...over }, { roots, stateDir: STATE, worktreesDir: WT });
const vcRefused = (over, re) => {
  const v = vc(over);
  assert.equal(v.ok, false, `expected refusal: ${JSON.stringify(over)}`);
  if (re) assert.match(v.reason, re);
};

test('vendor-card: a good op yields a recipe with the fields and no argv', () => {
  const v = vc({});
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.recipe.kind, 'vendor-card');
  assert.equal(v.recipe.vendor, 'gemini');
  assert.equal(v.recipe.model, 'Gemini 3.8 Flash (High)');
  assert.equal(v.recipe.branch, 'card/glmps-2-0-81');
  assert.equal(v.recipe.base, 'glmps2/main');
  assert.equal(v.recipe.cardId, 'glmps-2-0-81');
  assert.equal(v.recipe.timeoutMs, 600000);
  assert.equal(v.recipe.args, undefined);
  assert.equal(vc({ model: null }).ok, true);
  assert.equal(vc({ timeoutMs: undefined }).recipe.timeoutMs, 1800000);
  assert.equal(vc({ timeoutMs: 9e12 }).recipe.timeoutMs, 24 * 60 * 60 * 1000);
});

test('vendor-card: bad cwd, vendor, model, refs, card id, title and prompt location are refused', () => {
  vcRefused({ cwd: 'D:\\glmps' }, /cwd/i);
  vcRefused({ cwd: `${WT}\\merge-queue\\x` }, /card worktree/i);
  vcRefused({ cwd: `${WT}\\glmps-2.0\\glmps-2-0-52-review-r1` }, /card worktree/i);
  vcRefused({ vendor: 'claude' }, /vendor/i);
  vcRefused({ vendor: 'gemini;calc' }, /vendor/i);
  for (const model of ['--yolo', 'x;y', 'a`b', 5, '']) vcRefused({ model }, /model/i);
  for (const branch of ['-x', 'a..b', 'a b', '', 'x;y']) vcRefused({ branch }, /branch/i);
  for (const base of ['-x', 'a..b', '$(x)']) vcRefused({ base }, /base/i);
  for (const cardId of ['', 'A B', '-x', 'x;y']) vcRefused({ cardId }, /card id/i);
  for (const title of ['', 'a\nb', 'caf\u00e9', 'x'.repeat(201), 5]) vcRefused({ title }, /title/i);
  vcRefused({ promptFile: `${STATE}\\elsewhere\\x.prompt.md` }, /prompt/i);
  vcRefused({ promptFile: `${STATE}\\runner\\sub\\x.prompt.md` }, /prompt/i);
  vcRefused({ promptFile: `${STATE}\\runner\\x.txt` }, /prompt/i);
});

test('vendor-card: finishOnly carries the agent summary; bad values are refused (AC-6)', () => {
  const v = vc({ finishOnly: true, agentText: 'done, AC-1 met' });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.recipe.finishOnly, true);
  assert.equal(v.recipe.agentText, 'done, AC-1 met');
  assert.equal(vc({}).recipe.finishOnly, false);
  assert.equal(vc({ agentText: 'ignored' }).recipe.agentText, null);
  vcRefused({ finishOnly: 'yes' }, /finishOnly/);
  vcRefused({ finishOnly: true, agentText: 'x'.repeat(4001) }, /agentText/);
  vcRefused({ finishOnly: true, agentText: 5 }, /agentText/);
});

const CLONES = 'C:\\Users\\op\\.glmps\\git-clones';
const cloneRoots = { repos: [CLONES, 'D:\\glmps'], worktrees: WT };
const cloneOk = (op) => validateGitopsOp(op, { roots: cloneRoots, worktreesDir: WT });
const URL_OK = 'https://github.com/Acme/widgets.git';
const DEST = `${CLONES}\\github.com\\Acme\\widgets.git`;
const clone = (over = {}) => ({ kind: 'git', cwd: CLONES, args: ['clone', '--mirror', '-q', URL_OK, DEST], ...over });

test('git clone --mirror -q of a github.com .git url into a dest strictly inside a root passes', () => {
  const v = cloneOk(clone());
  assert.equal(v.ok, true, v.reason);
  assert.deepEqual(v.recipe.args, ['clone', '--mirror', '-q', URL_OK, DEST]);
  assert.equal(v.recipe.cwd, CLONES);
  assert.equal(cloneOk(clone({ args: ['clone', '--mirror', '-q', URL_OK, `${CLONES}/github.com/Acme/widgets.git`] })).ok, true, 'forward slashes');
});

test('git clone: any other shape, host, url, dest or cwd is refused', () => {
  const bad = (op, re) => { const v = cloneOk(op); assert.equal(v.ok, false, JSON.stringify(op.args)); if (re) assert.match(v.reason, re); };
  for (const args of [
    ['clone', URL_OK, DEST],
    ['clone', '--mirror', URL_OK, DEST],
    ['clone', '-q', '--mirror', URL_OK, DEST],
    ['clone', '--mirror', '-q', URL_OK],
    ['clone', '--mirror', '-q', URL_OK, DEST, 'extra'],
    ['clone', '--mirror', '-q', '--depth=1', URL_OK, DEST],
    ['clone', '--mirror', '-q', '--upload-pack=calc', URL_OK, DEST],
    ['clone', '--mirror', '-q', '--config', 'core.sshCommand=calc', URL_OK, DEST],
    ['clone', '--mirror', '-q', 'https://gitlab.com/Acme/widgets.git', DEST],
    ['clone', '--mirror', '-q', 'http://github.com/Acme/widgets.git', DEST],
    ['clone', '--mirror', '-q', 'https://github.com.evil.example/Acme/widgets.git', DEST],
    ['clone', '--mirror', '-q', 'https://user@github.com/Acme/widgets.git', DEST],
    ['clone', '--mirror', '-q', 'https://github.com/Acme/widgets', DEST],
    ['clone', '--mirror', '-q', 'https://github.com/Acme/widgets.git/extra.git', DEST],
    ['clone', '--mirror', '-q', 'https://github.com/../widgets.git', DEST],
    ['clone', '--mirror', '-q', 'https://github.com/Acme/..git', DEST],
    ['clone', '--mirror', '-q', 'git@github.com:Acme/widgets.git', DEST],
    ['clone', '--mirror', '-q', 'file:///srv/widgets.git', DEST],
    ['clone', '--mirror', '-q', 'C:\\repos\\widgets.git', DEST],
    ['clone', '--mirror', '-q', URL_OK, 'relative\\widgets.git'],
    ['clone', '--mirror', '-q', URL_OK, `${CLONES}\\github.com\\Acme\\widgets`],
    ['clone', '--mirror', '-q', URL_OK, CLONES],
    ['clone', '--mirror', '-q', URL_OK, 'C:\\Windows\\widgets.git'],
    ['clone', '--mirror', '-q', URL_OK, `${CLONES}\\..\\evil.git`],
    ['clone', '--mirror', '-q', URL_OK, 'D:\\glmpsx\\widgets.git'],
  ]) bad(clone({ args }));
  bad(clone({ cwd: 'C:\\Windows' }), /outside the allowed roots/);
  bad(clone({ cwd: null }));
  bad(clone({ args: ['-c', 'core.sshCommand=calc', 'clone', '--mirror', '-q', URL_OK, DEST] }));
});

test('git fetch -q --prune origin inside the clones root is still the allowed fetch shape', () => {
  const v = cloneOk({ kind: 'git', cwd: DEST, args: ['fetch', '-q', '--prune', 'origin'] });
  assert.equal(v.ok, true, v.reason);
});

// The full-suite loop reads first-parent merges with log, so rev-list is not
// on the allowlist in any form (glmps-2-0-runtime-128, -130).
test('rev-list is refused in every form, and log --first-parent --format=%H is the merge-listing shape', () => {
  const git = (args) => ({ kind: 'git', args, cwd: roots.repos[0] });
  refused(git(['rev-list', '--first-parent', '--count', 'abc..def']), /not allowed/);
  refused(git(['rev-list', '--first-parent', '--reverse', 'abc..def']), /not allowed/);
  refused(git(['rev-list', '--all']), /not allowed/);
  assert.equal(ok(git(['log', '--first-parent', '--format=%H', 'abc..def'])).ok, true);
  refused(git(['log', '--first-parent', '--reverse', 'abc..def']), /flag is not allowed/);
});

// Card glmps-2-0-216: the one release action. Values only; the sequence is fixed in release-run.js.
const REL = { kind: 'release', cwd: 'D:\\glmps-2.0', repo: 'wolfeb-dev/glmps-2.0', base: 'main', number: 212, cardId: 'glmps-2-0-214', bump: 'minor', summary: 'Delivered the fix.\nRisk: none.' };

test('release: a good op yields a recipe of values with no argv', () => {
  const v = ok({ ...REL, args: ['push', '--force'] });
  assert.equal(v.ok, true, v.reason);
  assert.deepEqual(v.recipe, { kind: 'release', cwd: REL.cwd, repo: REL.repo, base: 'main', number: 212, cardId: REL.cardId, bump: 'minor', summary: REL.summary, timeoutMs: 10 * 60 * 1000 });
  assert.equal(ok({ ...REL, summary: undefined }).recipe.summary, '');
  assert.equal(ok({ ...REL, bump: 'patch' }).ok, true);
});

test('release: a checkout outside the repos, the public repo, a bad ref, number, card id, bump or summary is refused', () => {
  refused({ ...REL, cwd: 'D:\\elsewhere' }, /cwd/);
  refused({ ...REL, cwd: `${WT}\\merge-queue\\x` }, /cwd/);
  refused({ ...REL, repo: 'wolfeb-dev/glmps' }, /public/);
  refused({ ...REL, repo: 'WOLFEB-DEV/GLMPS' }, /public/);
  refused({ ...REL, repo: 'not a repo' }, /repo/);
  for (const base of ['--force', 'main..x', 'a b', '', 'refs/heads/main;rm', '+main']) refused({ ...REL, base }, /base/);
  for (const number of ['12', -1, 0, 1.5, 1e12]) refused({ ...REL, number }, /number/);
  refused({ ...REL, cardId: 'Bad Id' }, /card id/);
  refused({ ...REL, bump: 'major' }, /bump/);
  refused({ ...REL, summary: 'x'.repeat(4001) }, /summary/);
  refused({ ...REL, summary: 'bell\u0007' }, /summary/);
});
