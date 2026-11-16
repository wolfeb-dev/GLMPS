// Card glmps-2-0-216: the release record the kernel really queues must pass
// this shell's real allowlist. Card glmps-2-0-209 tested its release against a
// fake git, and on the service every step was refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateGitopsOp } from '../src/lib/gitops-allow.js';
import { createLaunchBroker } from '../../../server/lib/orchestration/launch-broker.js';
import { createGitopsBroker } from '../../../server/lib/orchestration/gitops-broker.js';
import { requestRelease } from '../../../server/lib/orchestration/release-version.js';
import { waitFor } from '../../../server/test/helpers/wait-for.js';

const REPO = 'D:\\glmps-2.0';
const WT = 'C:\\Users\\op\\.glmps2\\runner\\worktrees';

async function queued({ mr, card, taskClass }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-release-contract-'));
  try {
    const launchBroker = createLaunchBroker({ file: path.join(dir, 'queue.json') });
    const broker = createGitopsBroker({ launchBroker, roots: () => ({ repos: [REPO], worktrees: WT }), pollMs: 5 });
    const done = requestRelease({ run: (op) => broker.run(op), repoPath: REPO, mr, card, taskClass });
    await waitFor(() => launchBroker.pending().length === 1, { message: 'the release record is queued' });
    const [rec] = launchBroker.pending();
    const v = validateGitopsOp(rec.op, { roots: rec.op.roots, worktreesDir: WT });
    launchBroker.claim(rec.id, 'desktop-shell');
    launchBroker.complete(rec.id, { result: { status: 0, stdout: '{"ok":true,"version":"2.1.0","sha":"x"}', stderr: '' } });
    return { v, result: await done };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const mr = { repo: 'wolfeb-dev/glmps-2.0', base: 'main', number: 212, prUrl: 'https://github.com/wolfeb-dev/glmps-2.0/pull/212' };

test('the kernel release record is accepted by the shell allowlist as values only', async () => {
  const { v, result } = await queued({ mr, card: { id: 'glmps-2-0-214', summary: 'Delivered the fix.\nRisk: none.' }, taskClass: 'feature' });
  assert.equal(v.ok, true, v.reason);
  assert.deepEqual(v.recipe, { kind: 'release', cwd: REPO, repo: mr.repo, base: 'main', number: 212, cardId: 'glmps-2-0-214', bump: 'minor', summary: 'Delivered the fix.\nRisk: none.', timeoutMs: 10 * 60 * 1000 });
  assert.deepEqual(result, { ok: true, version: '2.1.0', sha: 'x' });
});

test('a card with no gate summary still passes', async () => {
  const { v } = await queued({ mr, card: { id: 'glmps-2-0-214' }, taskClass: 'debug' });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.recipe.bump, 'patch');
});

test('the public repo is refused even when the kernel asks', async () => {
  const { v } = await queued({ mr: { ...mr, repo: 'wolfeb-dev/glmps' }, card: { id: 'glmps-2-0-214' }, taskClass: 'debug' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /public/);
});
