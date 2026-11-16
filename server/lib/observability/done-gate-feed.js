// server/lib/observability/done-gate-feed.js
// Turn the Stop-hook gate's per-session JSONL (one result per line, written by
// hooks/done-gate.js) into shared-shape dashboard events bound to the session.
// Pure: takes the file text, returns events[] - the /api/state?session handler reads
// <doneGateDir>/<sid>.jsonl and merges these into the session's event list (like gaps/guiding).

const LANE = { pass: 'feed', block: 'feed', yield: 'feed', skipped: 'context', unapproved: 'feed' };

function labelFor(result, failedCommand) {
  switch (result) {
    case 'pass': return 'done-gate: passed';
    case 'block': return `done-gate: blocked - ${failedCommand || 'command'} failed`;
    case 'yield': return `done-gate: yielded after 3 blocks (${failedCommand || 'command'} still failing)`;
    case 'skipped': return 'done-gate: skipped (bypassed)';
    case 'unapproved': return 'done-gate: acceptance.md not operator-approved, commands not run';
    default: return null;
  }
}

export function doneGateEvents(jsonlText, sessionId, { max = 50 } = {}) {
  if (typeof jsonlText !== 'string' || !jsonlText) return [];
  const out = [];
  for (const line of jsonlText.split('\n')) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const lane = LANE[r?.result];
    if (!lane) continue; // unknown / missing result
    const label = labelFor(r.result, r.failedCommand);
    // result is what loopStage() and the session page's verdict slot read; the
    // label alone could not tell them a gate passed.
    out.push({ kind: 'done-gate', lane, tool: 'done-gate', path: null, ts: r.ts ?? null, sessionId, label,
      result: r.result, failedCommand: r.failedCommand ?? null });
  }
  return out.slice(-max);
}
