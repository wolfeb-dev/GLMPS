// server/lib/orchestration/workspace-signal.js
// Turns a high-divergence verdict into a deduped capability signal so the
// declared-vs-observed drift is a first-class learning signal, not a
// dashboard-only curiosity. Pure; the server records the returned signal.
export function workspaceSignal(divergence, { sessionId, seen }) {
  if (!divergence || divergence.level !== 'high') return null;
  const detail = (divergence.reasons ?? []).join('; ');
  const key = `${sessionId}::${detail}`;
  if (seen.has(key)) return null;
  seen.add(key);
  return { code: 'workspace-divergence', sessionId, detail, ts: divergence.ts ?? 0 };
}
