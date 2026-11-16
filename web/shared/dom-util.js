// web/shared/dom-util.js
// Tiny DOM/string pure helpers duplicated (byte-identically, modulo naming)
// across view modules - collected here so each view imports one copy
// (glmps-63). No top-level DOM access: safe to import under Node for tests.

// XSS discipline: textContent only, never innerHTML with data.
export function setText(el, s) {
  el.textContent = String(s ?? '');
}

// Last path segment of a cwd (forward or back slashes), '' when absent.
export function cwdLastSeg(cwd) {
  if (!cwd) return '';
  const trimmed = String(cwd).replace(/[/\\]+$/, '');
  const seg = trimmed.split(/[/\\]/).pop();
  return seg ?? trimmed;
}

// glmps-8b: a session is `internal` (tagged by the server -
// server/lib/observability/sessions.js's isInternalSession, e.g. the memory
// distiller's own headless claude -p extraction spawns) when it is Mission
// Control's own worker process, not a real user session. `internal` sessions
// are never removed from state.sessions (tag, don't hide), so every view
// that counts, highlights, or pins "live" sessions must exclude them here or
// the dashboard contradicts itself (a live count in one view, a different
// one two clicks away). This is the single place that predicate lives - every
// call site imports it rather than re-deriving `s.live && !s.internal`
// inline (the earlier state of this file had exactly that duplication
// spread across five modules, the same species of drift as the two
// independent metricValue unwrappers this file already exists to prevent).
export function countsAsLive(session) {
  return !!session?.live && !session?.internal;
}

// server/lib/evaluation/evidence.js's tagValue() wraps every summarized loop
// metric (medianTurns, verifierPassRate, firstTryRate, medianContextUsage,
// medianChurn) as { value, evidence: 'measured'|'constant'|'absent', n,
// reason? } instead of a bare number, so a dead/fabricated number (e.g. the
// pre-fix firstTryRate:1 constant) can never be mistaken for a real
// measurement. These two helpers are the single place every view unwraps
// that envelope for display, so a bare (untagged) value from an older
// fixture or a not-yet-migrated caller still renders correctly.

// The display value: unwraps `.value` off a tagged envelope, or passes a
// bare number/boolean straight through.
export function metricValue(v) {
  return (v != null && typeof v === 'object' && 'evidence' in v) ? v.value : v;
}

// A human label for a tagged envelope's evidence when it is NOT 'measured'
// ('constant' or 'absent') so the UI never silently prints a computed number
// for a metric that is actually a dead constant or missing entirely. Returns
// null for 'measured' envelopes and for bare (untagged) values -- callers
// fall through to their own numeric formatter on metricValue(v) in that case.
export function evidenceLabel(v) {
  if (v == null || typeof v !== 'object' || !('evidence' in v)) return null;
  if (v.evidence === 'absent') return 'not captured';
  if (v.evidence === 'constant') return `no variance (n=${v.n})`;
  return null;
}

// The one sanctioned way to empty a container: no HTML parsing involved, so
// the XSS rule against innerHTML needs no exception for it.
export function clear(node) {
  node.replaceChildren();
}
