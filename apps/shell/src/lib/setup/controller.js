// apps/shell/src/lib/setup/controller.js
// The wizard's brain, with every effect injected so it tests without electron:
// it keeps the last health report, the progress record and the last result of
// each step, builds the State (plan.js), and dispatches a renderer request to
// the handler map (actions.js). setup-window.js only wires it to IPC.
import { buildState, markCompleted, markSkipped, STEP_ORDER } from './plan.js';
import { linkUrl as defaultLinkUrl } from './links.js';

const INPUT_KEYS = ['botToken', 'appToken', 'email', 'memberId', 'folder', 'engagement'];

// Only the named string inputs reach a handler; nothing else the page sent.
function pickInput(input) {
  const out = {};
  if (input && typeof input === 'object') for (const k of INPUT_KEYS) if (typeof input[k] === 'string') out[k] = input[k];
  return out;
}

export function createSetupController({ probe, handlers, readProgress, writeProgress, openExternal, linkUrl = defaultLinkUrl, finish, launchAtLogin = true, log = () => {} }) {
  let status = null;
  let progress = readProgress();
  let busy = false;
  let running = null;
  let results = {};
  const listeners = new Set();

  const state = () => buildState({ status, progress, busy, running, results, launchAtLogin });
  const emit = () => { const s = state(); for (const fn of listeners) { try { fn(s); } catch { /* a closed window */ } } };

  async function refresh() {
    try { status = await probe(); } catch (e) { log('warn', 'setup: health probe failed', { error: e?.message }); }
  }

  const save = (next) => {
    progress = next;
    try { writeProgress(progress); } catch (e) { log('warn', 'setup: progress not saved', { error: e?.message }); }
  };

  return {
    async getState() {
      if (!status) await refresh();
      return state();
    },
    onState(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async run(stepId, actionId, input) {
      if (!STEP_ORDER.includes(stepId) || typeof actionId !== 'string') return { ok: false, message: 'Unknown step.' };
      if (busy) return { ok: false, message: 'Another action is still running.' };
      if (!status) await refresh();
      const step = state().steps.find((s) => s.id === stepId);
      if (!step.actions.some((a) => a.id === actionId)) return { ok: false, message: 'That action is not available right now.' };
      log('info', 'setup: action', { stepId, actionId });
      if (actionId === 'begin') { delete results[stepId]; save(markCompleted(progress, stepId)); emit(); return { ok: true, message: '' }; }
      if (actionId === 'skip') { delete results[stepId]; save(markSkipped(progress, stepId)); emit(); return { ok: true, message: '' }; }
      busy = true;
      running = stepId;
      emit();
      let r;
      try {
        if (actionId === 'recheck') r = { ok: true, message: '' };
        else {
          const handler = handlers[`${stepId}:${actionId}`];
          r = handler ? await handler(pickInput(input)) : { ok: false, message: 'That action is not available right now.' };
        }
      } catch (e) {
        log('warn', 'setup: action threw', { stepId, actionId, error: e?.message });
        r = { ok: false, message: 'That did not finish. Try again, or skip the step.' };
      }
      results[stepId] = { ok: Boolean(r?.ok), message: String(r?.message ?? '') };
      await refresh();
      busy = false;
      running = null;
      emit();
      return results[stepId];
    },
    async openLink(key) {
      const url = linkUrl(key);
      if (!url) return { ok: false };
      try { await openExternal(url); return { ok: true }; } catch (e) { log('warn', 'setup: link not opened', { key, error: e?.message }); return { ok: false }; }
    },
    async finish({ launchAtLogin: on } = {}) {
      launchAtLogin = on !== false;
      await finish({ launchAtLogin });
      return { ok: true };
    },
  };
}
