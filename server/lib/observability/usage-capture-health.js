// server/lib/observability/usage-capture-health.js
// Detects a broken statusline usage tap. glmps-188: settings.json statusLine
// was displaced from taps/statusline-chain.js and no usage record landed for
// 21 days, with nothing in GLMPS noticing. Two findings:
//   displaced - statusLine.command no longer runs the chain (a verified fact)
//   silent    - Claude Code sessions are active but no record landed for the
//               window (an inference, so suppressed while displaced explains it)
// Design: docs/specs/2026-10-19-usage-capture-silence-alert.md
import fs from 'node:fs';
import path from 'node:path';

export const CHAIN_MARKER = 'statusline-chain.js';
export const DEFAULT_SILENT_HOURS = 6;

export function usageCaptureFindings({ settingsReadable = false, statusLineCommand = null, everInstalled = false,
  lastRecordMs = null, sessions = [], nowMs = Date.now(), silentHours = DEFAULT_SILENT_HOURS } = {}) {
  // Unknown is not broken: an unreadable settings.json, or a machine where the
  // tap was never installed, raises nothing.
  if (!everInstalled) return [];
  const command = typeof statusLineCommand === 'string' ? statusLineCommand : null;
  if (settingsReadable && !(command && command.includes(CHAIN_MARKER))) {
    return [{ kind: 'displaced', command }];
  }
  const windowMs = (Number(silentHours) > 0 ? Number(silentHours) : DEFAULT_SILENT_HOURS) * 3600 * 1000;
  if (lastRecordMs != null && nowMs - lastRecordMs < windowMs) return [];
  const liveSessions = (Array.isArray(sessions) ? sessions : []).filter((s) =>
    s && s.tool === 'claude-code' && Number(s.lastTs) > 0 && nowMs - Number(s.lastTs) <= windowMs).length;
  if (!liveSessions) return [];
  return [{ kind: 'silent', lastRecordMs, liveSessions, silentHours: windowMs / 3600000 }];
}

export function readUsageCaptureInputs({ settingsFile, stateDir }) {
  let settingsReadable = false;
  let statusLineCommand = null;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    settingsReadable = true;
    if (typeof settings?.statusLine?.command === 'string') statusLineCommand = settings.statusLine.command;
  } catch {}

  // Newest mtime, not a parse of every NDJSON file: /api/alerts recomputes per call.
  let lastRecordMs = null;
  const usageDir = path.join(stateDir, 'usage');
  let files = [];
  try { files = fs.readdirSync(usageDir).filter((f) => f.endsWith('.ndjson')); } catch {}
  for (const f of files) {
    try {
      const m = fs.statSync(path.join(usageDir, f)).mtimeMs;
      if (lastRecordMs == null || m > lastRecordMs) lastRecordMs = m;
    } catch {}
  }

  const everInstalled = lastRecordMs != null || fs.existsSync(path.join(stateDir, 'state', 'statusline-delegate.json'));
  return { settingsReadable, statusLineCommand, everInstalled, lastRecordMs };
}
