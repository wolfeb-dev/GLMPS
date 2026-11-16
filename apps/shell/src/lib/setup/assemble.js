// apps/shell/src/lib/setup/assemble.js
// Wires the real effects (kernel scripts, visible consoles, the progress file)
// into the controller. Pure of electron: setup-window.js supplies the shell
// pieces (openExternal, restartKernel, finish) and owns the window.
import fs from 'node:fs';
import { createSetupController } from './controller.js';
import { createSetupHandlers, runKernelScript, runVisible, refreshPathFromRegistry } from './actions.js';
import { progressFile, readProgress, writeProgress } from './plan.js';

export function createSetupService({ kernel, userData, profileFile, stateDirOverride = null, kernelStateDir = null, restartKernel, finish, openExternal, log,
  kernelScript = runKernelScript, visible = runVisible, refreshPath = refreshPathFromRegistry, env = process.env, platform = process.platform, fsImpl = fs }) {
  const file = progressFile(userData);
  let statusState = null;
  let probes = 0;

  // The first probe skips the winget "newest version" lookups so the wizard
  // opens at once; later ones (after an action, or Check again) include them.
  async function probe() {
    if (!kernel) throw new Error('no local kernel');
    const first = probes === 0;
    probes += 1;
    const r = await kernelScript({ node: kernel.node, kernelDir: kernel.kernelDir, script: 'scripts/setup/setup-status.mjs', args: [...(first ? ['--no-latest'] : []), profileFile],
      env: stateDirOverride ? { GLMPS_STATE_DIR: stateDirOverride } : {} });
    if (!r.json) throw new Error(r.error ?? `setup-status exited ${r.code}`);
    statusState = r.json;
    return statusState;
  }

  const handlers = createSetupHandlers({
    visible,
    kernelScript,
    refreshPath: async () => { if (platform === 'win32') { try { env.PATH = await refreshPath({ env }); } catch (e) { log('warn', 'setup: PATH refresh failed', { error: e?.message }); } } },
    kernel, userData, stateDirOverride, kernelStateDir, getStatus: () => statusState ?? {}, restartKernel, log, fsImpl,
  });

  return createSetupController({
    probe, handlers, openExternal, finish, log,
    readProgress: () => readProgress({ file, fsImpl }),
    writeProgress: (progress) => writeProgress({ file, progress, fsImpl }),
  });
}
