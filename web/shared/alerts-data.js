// web/shared/alerts-data.js
// Pure alert helpers (no DOM): acknowledgement. Grouping is the server's
// (GET /api/alerts `attention`, server/lib/observability/alert-groups.js).
export { getAlerts } from './api.js';

export const ACK_KEY = 'glmps_acked_alerts';
export const ackedSet = () => { try { return new Set(JSON.parse(localStorage.getItem(ACK_KEY) || '[]')); } catch { return new Set(); } };
export const saveAcked = (s) => { try { localStorage.setItem(ACK_KEY, JSON.stringify([...s])); } catch {} };


/** Alerts not yet acknowledged. ackedIds: Set or array of ids. */
export function activeAlerts(alerts, ackedIds) {
  const acked = ackedIds instanceof Set ? ackedIds : new Set(ackedIds ?? []);
  return (alerts ?? []).filter(a => !acked.has(a.id));
}

