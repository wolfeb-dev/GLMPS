// server/lib/governance/actors.js
// Thin actor identity + gate-authorization spine (glmps-72 Workstream B).
// cfg.actors is a config TABLE, not a profile system: an optional list of
// { id, name?, roles: string[], token?, notify? }. Absent/empty
// list = solo mode; gateCheck is then ALWAYS a no-op (allowed:true) so a
// single-operator setup behaves byte-identically to before this existed.
// Desks/agents/executors never see this module - authorization hangs on the
// existing typed gates (backlog approve, runner claim), not a generic RBAC.
import { tokenMatches } from './access-guard.js';

function normStr(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function normRoles(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter(r => typeof r === 'string' && r.trim()).map(r => r.trim()))];
}

// notify is a thin, not-yet-enforced notification-routing profile (B3); accept
// a non-empty string or a plain object, drop anything else rather than throw.
function normNotify(v) {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  return null;
}

/**
 * Validate + normalize cfg.actors. Malformed entries (missing/blank id,
 * non-object) are dropped rather than throwing, so a sloppy config degrades
 * to "actor not recognized" instead of a server crash.
 * @param {{actors?: unknown}} cfg
 * @returns {Array<{id:string, name:string|null, roles:string[], token:string|null, notify:*}>}
 */
export function loadActors(cfg = {}) {
  const list = Array.isArray(cfg?.actors) ? cfg.actors : [];
  const out = [];
  for (const a of list) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) continue;
    const id = normStr(a.id);
    if (!id) continue;
    out.push({
      id,
      name: normStr(a.name),
      roles: normRoles(a.roles),
      token: normStr(a.token),
      notify: normNotify(a.notify),
    });
  }
  return out;
}

/**
 * Constant-time token -> actor lookup (reuses access-guard's timing-safe
 * compare so a second per-actor secret doesn't reintroduce a timing side
 * channel). Returns null for an empty/absent token or no match.
 * @param {Array} actors
 * @param {string} [token]
 * @returns {object|null}
 */
export function actorForToken(actors = [], token) {
  if (!token) return null;
  for (const a of actors) {
    if (a.token && tokenMatches(token, a.token)) return a;
  }
  return null;
}

/** @returns {boolean} true when `role` is falsy (nothing to hold), else membership. */
export function actorHasRole(actors = [], actorId, role) {
  if (!role) return true;
  const a = actors.find(x => x.id === actorId);
  return !!a && a.roles.includes(role);
}

/**
 * Pure authorization decision for a gated action. Solo mode (cfg.actors empty
 * or absent) is ALWAYS a no-op - zero behavior change until a team exists.
 * @param {{actors?: Array, actorId?: string|null, role?: string|null}} opts
 * @returns {{allowed: true} | {allowed: false, reason: string}}
 */
export function gateCheck({ actors = [], actorId, role } = {}) {
  if (!actors.length) return { allowed: true };
  if (!role) return { allowed: true };
  const actor = actors.find(a => a.id === actorId);
  if (!actor) return { allowed: false, reason: actorId ? `unknown actor '${actorId}'` : 'no actor identified' };
  if (!actor.roles.includes(role)) return { allowed: false, reason: `actor '${actorId}' lacks role '${role}'` };
  return { allowed: true };
}
