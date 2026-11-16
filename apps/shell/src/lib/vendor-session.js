// apps/shell/src/lib/vendor-session.js
// The Antigravity tab side of a non-Claude card (AC-6). The runner queues a
// companion terminal whose command runs apps/shell/scripts/vendor-session.mjs with a
// session file it wrote in its state dir. This starts the vendor CLI in its
// interactive mode in the card worktree, behind the same push fence as the
// headless path, with the terminal attached so the operator can watch and type.
// Each time the agent writes its done file, and when the CLI exits, the runner
// is told; each signal has the desktop app verify, test, commit, push and file the PR.
// Everything that touches a process, a file or the network is injected.
import { fencedAgentEnv, interactiveVendorArgs, chooseAgyModel } from './vendor-card.js';

const POLL_MS = 2000;
const NONCE = /^[0-9a-f]{32}$/;
const CARD_ID = /^[a-z0-9][a-z0-9-]{1,80}$/;

export function taskInstructionFor(promptFile) {
  return `Read the task described in this file and complete it: ${promptFile}`;
}

export function validateSession(s, { promptArg = null } = {}) {
  if (!s || typeof s !== 'object') return 'the session file is not a JSON object';
  if (typeof s.cardId !== 'string' || !CARD_ID.test(s.cardId)) return 'the session file names no card';
  if (typeof s.nonce !== 'string' || !NONCE.test(s.nonce)) return 'the session file carries no run nonce';
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) return 'the session file names no server port';
  for (const k of ['cwd', 'promptFile', 'doneFile']) if (typeof s[k] !== 'string' || !s[k]) return `the session file has no ${k}`;
  if (promptArg != null && promptArg !== s.promptFile) return 'the prompt file on the command line is not the session\'s';
  if (!interactiveVendorArgs({ vendor: s.vendor, model: s.model ?? null, cwd: s.cwd, instruction: '' })) return `no interactive mode for vendor ${String(s.vendor).slice(0, 40)}`;
  return null;
}

/**
 * Runs one tab session. deps: { spawn(file, args, opts) -> child with
 * on('exit'), resolveBinary(name), exists(path), post(url, body) -> Promise<{status, body}>,
 * log(text), env, setInterval, clearInterval, listModels() -> the model names
 * `agy models` lists, or [] when it could not be read (Gemini only) }.
 * Resolves with { event, exitCode, signalled, rounds } once the CLI exits.
 */
export function runVendorSession(session, deps) {
  const { spawn, resolveBinary, exists, post, log = () => {}, env = {}, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, listModels = null } = deps;
  const pick = session.vendor === 'gemini' && listModels ? chooseAgyModel(session.model ?? null, listModels()) : { model: session.model ?? null };
  const model = pick.model ?? null;
  const spec = interactiveVendorArgs({ vendor: session.vendor, model, cwd: session.cwd, instruction: taskInstructionFor(session.promptFile) });
  const url = `http://127.0.0.1:${session.port}/api/backlog/${session.cardId}/vendor-session`;
  // Each done file is one hand-off round (card glmps-2-0-172, F4): the runner
  // consumes the file when it starts that round's finish, which re-arms the
  // poll, and the exit is always reported so later tab work is finished too.
  let signalled = null;
  let rounds = 0;
  let armed = true;
  const signal = async (event, extra = {}) => {
    signalled = event;
    rounds += 1;
    try {
      const r = await post(url, { nonce: session.nonce, event, ...extra });
      log(r.status === 200 || r.status === 202
        ? 'GLMPS: the runner is checking, testing and pushing this work; the result is posted on the card.'
        : `GLMPS: the runner did not take the finish signal (${r.status}): ${JSON.stringify(r.body ?? '').slice(0, 300)}`);
    } catch (e) {
      log(`GLMPS: could not reach the runner at ${url}: ${e?.message ?? e}`);
    }
    return event;
  };
  return new Promise((resolve) => {
    if (pick.error) {
      log(`GLMPS: ${pick.error}`);
      signal('exit', { exitCode: -1, error: pick.error }).then(() => resolve({ event: 'exit', exitCode: -1, signalled }));
      return;
    }
    const bin = resolveBinary(spec.file);
    if (!bin) {
      log(`GLMPS: the ${spec.file} CLI was not found on PATH or in ~/.local/bin.`);
      signal('exit', { exitCode: -1, error: `${spec.file} not found` }).then(() => resolve({ event: 'exit', exitCode: -1, signalled }));
      return;
    }
    log(`GLMPS card ${session.cardId} on ${session.vendor}${model ? ` (${model})` : ''}. This agent cannot push; when it writes its summary the runner verifies, tests and opens the PR.`);
    const child = spawn(bin, spec.args, { cwd: session.cwd, stdio: 'inherit', env: fencedAgentEnv(env), windowsHide: false });
    const timer = setIntervalImpl(() => {
      const present = exists(session.doneFile);
      if (armed && present) { armed = false; signal('done'); } else if (!armed && !present) armed = true;
    }, POLL_MS);
    child.on('exit', (code) => {
      clearIntervalImpl(timer);
      const exitCode = Number.isInteger(code) ? code : -1;
      const done = armed && exists(session.doneFile);
      signal(done ? 'done' : 'exit', { exitCode })
        .then(() => resolve({ event: signalled, exitCode, signalled, rounds }));
    });
  });
}
