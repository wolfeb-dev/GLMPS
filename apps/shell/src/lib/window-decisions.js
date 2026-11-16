// apps/shell/src/lib/window-decisions.js
// Decisions shell-window.js applies, kept pure (no electron) so they run in
// the root test suite. Task 15 fix round: SF-2, W1, W2.
import { externalUrl } from './navigation.js';

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

// SF-2: an external link the system browser could not open used to be a
// shell.log line only, so a click in either pane did visibly nothing. A
// rejection now also tells the operator. The unsafe-URL refusal stays
// log-only on purpose: it is a security refusal, expected to be noisy
// (Slack's own page links to all sorts of blocked things) and not something
// the operator can act on per occurrence.
// Resolves 'opened' | 'refused' | 'failed'; never rejects.
export async function openExternalSafely({ url, openExternal, log, notify, role = null }) {
  const safe = externalUrl(url);
  if (!safe) {
    log('warn', 'refused to open an unsafe external URL', { role, url: String(url).slice(0, 200) });
    return 'refused';
  }
  try {
    await openExternal(safe);
    return 'opened';
  } catch (e) {
    const reason = e?.message || String(e);
    log('error', 'openExternal failed', { url: safe, error: reason });
    notify('Could not open the link', `${safe.slice(0, 200)}: ${reason}`);
    return 'failed';
  }
}

// a dashboard page that finishes AFTER the load timeout already fired
// clears that timeout failure (and only that one: a crash or a real load
// error is not undone by a later finish), then is revealed when it is on the
// kernel's own origin. Origins are compared parsed, never by string prefix.
export function dashboardLoadedDecision({ loadFailure, url, kernelOrigin }) {
  const onKernel = originOf(url) !== null && originOf(url) === kernelOrigin;
  const clearFailure = onKernel && loadFailure === 'load-failed:timeout';
  const remaining = clearFailure ? null : loadFailure;
  return { clearFailure, reveal: onKernel && !remaining };
}

// a Slack link to the kernel starts a dashboard load only while the
// supervisor says the kernel is answering. Otherwise the dashboard pane is
// just focused, so the offline page keeps its true reason (and, for a
// missing service, its install command) instead of "loading the dashboard
// failed".
export function slackToDashboardAction(supervisorState) {
  return supervisorState === 'up' || supervisorState === 'degraded' ? 'load' : 'focus';
}
