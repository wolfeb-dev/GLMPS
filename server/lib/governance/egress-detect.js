// server/lib/governance/egress-detect.js
// Governance: sensitive-data egress detection over the session event stream. Flags when an
// agent session touches a SECRET file (credentials/keys/env/ssh) or PROTECTED/prod-zone
// content - data that then flows into the model's context. Reuses zones.classifyPath for the
// prod-zone call and a secret-file check mirroring the file-api denylist. Feeds the alert center.
import { classifyPath } from '../zones.js';

const RANK = { warn: 1, critical: 2 };

/** Secret-file heuristic (mirrors server/lib/governance/file-api.js's denylist). */
export function isSecretPath(p) {
  if (typeof p !== 'string' || !p) return false;
  const s = p.replace(/\\/g, '/').toLowerCase();
  const base = s.split('/').pop() || '';
  if (/\.(pem|key)$/.test(base)) return true;
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (base === '.credentials.json') return true;
  if (base.startsWith('id_rsa') || base.startsWith('id_ed25519') || base.startsWith('id_ecdsa')) return true;
  if (/(^|\/)\.(ssh|aws|gnupg)(\/|$)/.test(s)) return true;
  return false;
}

// glmps-193: GET /api/alerts runs this over every in-memory event (~95k) on
// each call. The verdict is kept per event object and reused while its inputs
// still match.
const verdicts = new WeakMap();
function classifyEvent(ev, p, projectRoot, config) {
  const hit = verdicts.get(ev);
  if (hit && hit.p === p && hit.projectRoot === projectRoot && hit.config === config) return hit.v;
  let v = { reason: null, severity: 'warn' };
  if (isSecretPath(p)) v = { reason: 'secret', severity: 'critical' };
  else {
    const c = classifyPath(p, projectRoot ? { projectRoot, config } : { relative: true, config });
    if (c.protected || c.env === 'prod') v = { reason: 'prod-zone', severity: 'warn' };
  }
  verdicts.set(ev, { p, projectRoot, config, v });
  return v;
}

/**
 * @param events  shared-shape events with .path (file-read/edit/tool)
 * @returns [{ sessionId, path, reason:'secret'|'prod-zone', severity, kind }] - worst per session
 */
export function detectEgress(events = [], { projectRoot, config } = {}) {
  const bySession = new Map();
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const p = typeof ev.path === 'string' ? ev.path : null;
    if (!p) continue;

    const { reason, severity } = classifyEvent(ev, p, projectRoot, config);
    if (!reason) continue;

    const sid = ev.sessionId ?? 'unknown';
    const prev = bySession.get(sid);
    if (!prev || RANK[severity] > RANK[prev.severity]) {
      bySession.set(sid, { sessionId: sid, path: p, reason, severity, kind: ev.kind ?? null });
    }
  }
  return [...bySession.values()];
}
