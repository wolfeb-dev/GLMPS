// apps/shell/src/lib/first-run.js
// Pure first-run decision: whether the setup wizard opens on its own at start.
// The wizard itself (setup-window.js) checks and installs; nothing here does.

// Fail open: settings that cannot be read open nothing.
export function shouldOpenSetup({ settings, smoke = false } = {}) {
  if (smoke || !settings || typeof settings !== 'object') return false;
  return settings.setupCompleted !== true && settings.setupWizardDismissed !== true;
}
