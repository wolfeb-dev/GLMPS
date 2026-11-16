// server/lib/huddle/agy-broker.js
// agy for a kernel that cannot run it. As a Windows service the kernel sits in
// session 0 and cannot load the operator's agy sign-in, and no service may hold
// the operator's credentials. So the call is queued on the launch broker as an
// 'agy' record and the desktop shell, which runs in the operator's own session,
// claims it through the authenticated launch protocol, runs agy and reports the
// text back. generate() has the contract of agyGenerate, so createAgySeat takes
// it as `generate` unchanged.
import { AGY_MODELS } from './agy-models.js';

const abortError = () => Object.assign(new Error('agy broker: aborted'), { name: 'AbortError' });

export function createAgyBroker({ launchBroker, timeoutMs = 45000, claimWaitMs = 5000, pollMs = 100 }) {
  async function generate(prompt, { model, signal = null, timeout = timeoutMs } = {}) {
    if (!AGY_MODELS.includes(model)) throw new Error(`agy broker: model is not on the allowlist: ${model}`);
    if (signal?.aborted) throw abortError();
    const { id } = launchBroker.enqueue({ origin: 'agy', command: 'agy', cwd: 'agy', model, prompt });
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      let timer = null;
      let onAbort = null;
      const end = (fn) => {
        clearTimeout(timer);
        if (onAbort) signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const giveUp = (error) => {
        // fail() leaves a record the shell already finished alone
        launchBroker.fail(id, error.message);
        end(() => reject(error));
      };
      onAbort = () => giveUp(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
      const poll = () => {
        const rec = launchBroker.get(id);
        const waited = Date.now() - t0;
        if (!rec) return end(() => reject(new Error('agy broker: the call record disappeared')));
        if (rec.state === 'done') return end(() => resolve(rec.text ?? ''));
        if (rec.state === 'failed') {
          const msg = rec.error || 'agy call failed';
          return end(() => reject(Object.assign(new Error(msg), /not signed in/.test(msg) ? { code: 'AGY_NOT_SIGNED_IN' } : {})));
        }
        if (rec.state === 'pending' && waited >= claimWaitMs) {
          return giveUp(Object.assign(new Error(`agy broker: no desktop shell picked this up within ${claimWaitMs} ms (is the GLMPS 2.0 desktop app running?)`), { code: 'AGY_NO_SHELL' }));
        }
        if (waited >= timeout) return giveUp(new Error(`agy broker: agy timed out after ${timeout} ms`));
        timer = setTimeout(poll, pollMs);
      };
      timer = setTimeout(poll, pollMs);
    });
  }
  return { generate };
}
