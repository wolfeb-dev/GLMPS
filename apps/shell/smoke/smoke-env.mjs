// apps/shell/smoke/smoke-env.mjs
// The environment the smoke run starts Electron with. Separate from
// run-smoke.mjs (which launches Electron at import) so a unit test can check
// it. Task 15, W3: GLMPS_STATE_DIR always points into the run's own temp dir,
// overriding anything inherited, so the shell under test never resolves the
// operator's real ~/.glmps-2 (and its launch runner never reads the
// real launch-token).
import path from 'node:path';

export function smokeEnv({ base = process.env, dir, stubUrl, stubControlUrl, result }) {
  const env = { ...base, GLMPS_SHELL_SMOKE: result, GLMPS_SHELL_USERDATA: path.join(dir, 'userData'),
    GLMPS_KERNEL_URL: stubUrl, GLMPS_SERVICE_NAME: 'GLMPS_SMOKE_NO_SUCH_SERVICE',
    GLMPS_STATE_DIR: path.join(dir, 'state'),
    // lets the probe prove a flapping kernel clears the dashboard
    // load timer (never load-failed:timeout over the true down state) without
    // waiting out the real 20 s. 3 s, not shorter: it also governs every
    // legitimate load in this run (Phase A's included), and must never fire
    // before a real local page finishes loading.
    GLMPS_SHELL_DASHBOARD_LOAD_TIMEOUT_MS: '3000',
    // the probe flips the stub up and down here, not on the kernel port,
    // which refuses connections while down.
    GLMPS_SMOKE_STUB_CONTROL: stubControlUrl ?? stubUrl,
    // one failed probe is a down kernel for this run: the real 3 failures
    // over 10 s (card glmps-2-0-runtime-65) outlast the probe's 5 s waits.
    GLMPS_SHELL_SUPERVISOR_FAIL_THRESHOLD: '1', GLMPS_SHELL_SUPERVISOR_NO_ANSWER_MS: '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
