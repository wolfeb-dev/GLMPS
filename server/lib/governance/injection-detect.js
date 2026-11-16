// server/lib/governance/injection-detect.js
// Governance: live prompt-injection detection over the session EVENT STREAM (not just
// backlog intake). Runs the existing poison-scan detectors over the text GLMPS captured
// from a session - tool labels, diffs, ingested content - and flags the worst hit per
// session. Feeds the alert center. Richer with the OTel bridge (tool-result bodies).
import { scanText, SEVERITY } from './poison-scan.js';

// CALIBRATION CAVEAT (dogfooded): this is a HEURISTIC pattern matcher, not a calibrated
// detector. It scans only the INGESTED side (labels + change.old - content the agent read/
// received), NOT change.new (the agent's own output), to cut the obvious false positives.
// It still over-fires on sessions whose content is legitimately ABOUT injection (security
// work, this very codebase). Proper precision needs provenance (external-ingested vs
// operator-authored) + a labeled eval set + a confidence threshold + excluding the operator's
// own session - see the glmps-self-improvement-loop spec. Treat hits as "review", not "block".

// Markers of operator-authored events. What the operator typed is trust=operator
// (same provenance model as backlog intake) - a URL or "act as" in their own
// prompt is not injected content. Claude's adapter emits prompts as kind:'prompt';
// most other adapters emit kind:'tool' with tool:'user', so both fields are
// checked against this list. Overridable for auditing.
const OPERATOR_KINDS = ['prompt', 'user'];

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;

// glmps-193: GET /api/alerts re-scans every in-memory event (~95k, ~300 ms) on
// each call, and almost none changed since the last one. The scanText verdict
// is kept per event object and reused while the scanned text still matches.
const verdicts = new WeakMap();
function scanEvent(ev, text) {
  const hit = verdicts.get(ev);
  if (hit && hit.text === text) return hit.res;
  const res = scanText(text);
  verdicts.set(ev, { text, res });
  return res;
}

// A URL is allowed when its host+path (protocol/www stripped) starts with an
// allowlisted prefix, e.g. 'github.com/wolfeb-dev' covers the operator's own repos.
function urlAllowed(url, allowDomains) {
  const bare = url.replace(/^https?:\/\//, '').replace(/^www\./, '');
  return allowDomains.some(d => bare.startsWith(d));
}

/**
 * @param events  shared-shape events [{ sessionId, kind, tool, label, detail, change:{old,new} }]
 * @param opts.skipKinds    event kinds to treat as operator-authored (default prompt/user)
 * @param opts.allowDomains url prefixes whose external-url hits are expected, not injections
 * @returns [{ sessionId, code, severity, sample, kind, tool }] - one worst finding per session
 */
export function scanEventsForInjection(events = [], { skipKinds = OPERATOR_KINDS, allowDomains = [] } = {}) {
  const bySession = new Map();
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (skipKinds.includes(ev.kind) || skipKinds.includes(ev.tool)) continue;
    // Ingested side only: label/detail + change.old (what the agent received), not change.new.
    const parts = [ev.label, ev.detail, ev.change?.old].filter(v => typeof v === 'string' && v.length);
    if (!parts.length) continue;
    const text = parts.join('\n');
    const res = scanEvent(ev, text);
    if (res.clean) continue;
    // external-url-only finding where every URL in the text is allowlisted -> expected, skip.
    if (allowDomains.length && res.flags.every(f => f === 'external-url')) {
      const urls = text.match(URL_RE) ?? [];
      if (urls.length && urls.every(u => urlAllowed(u, allowDomains))) continue;
    }
    const sid = ev.sessionId ?? 'unknown';
    const prev = bySession.get(sid);
    if (!prev || SEVERITY[res.severity] > SEVERITY[prev.severity]) {
      bySession.set(sid, {
        sessionId: sid,
        code: res.flags[0] ?? 'injection',
        severity: res.severity,
        sample: res.matches[0]?.sample ?? '',
        kind: ev.kind ?? null,
        tool: ev.tool ?? null,
      });
    }
  }
  return [...bySession.values()];
}
