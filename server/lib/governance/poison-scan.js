// server/lib/governance/poison-scan.js
// Zero-dependency detection core for AI-agent poisoning signals in ingested
// text (backlog tickets, transcript-derived deferrals, memory/CLAUDE writes).
//
// Pure functions, no I/O. Two outputs:
//   scanText(text)   -> { flags, severity, clean, matches }
//   classifyTrust()  -> 'operator' | 'external'
//   scanTicket(item) -> provenance: { trust, flags, severity, quarantined, scannedAt? }
//
// Design notes:
// - "critical" flags are block-worthy (instruction override, authority spoof,
//   exfiltration-to-endpoint, embedded credentials, hidden Unicode tag chars).
// - "warn" flags are surface-worthy but common enough that they should not, on
//   their own, block an OPERATOR-authored ticket (bare URLs, memory-style
//   phrasing, zero-width chars, suspicious base64).
// - The quarantine policy intentionally treats EXTERNAL-trust content (anything
//   not authored at the operator's keyboard, e.g. transcript-derived deferral
//   tickets) more strictly: ANY flag quarantines it. This closes the
//   self-amplifying loop where injected transcript text becomes an executed job.

export const SEVERITY = { none: 0, warn: 1, critical: 2 };
const RANK = ['none', 'warn', 'critical'];

// Ordered roughly by specificity. Each detector contributes its code once.
const DETECTORS = [
  // Hidden / invisible characters first - strong signal, near-zero false positives.
  ['unicode-tag', 'critical', /[\u{E0000}-\u{E007F}]/u],
  ['zero-width', 'warn', /[\u200B-\u200F\u2060\uFEFF]/u],

  // Instruction override ("ignore/disregard/forget previous instructions", "new instructions:").
  ['instruction-override', 'critical',
    /\b(ignore|disregard|forget|override)\b[\s\S]{0,40}\b(all\s+|any\s+|the\s+|your\s+)?(previous|prior|earlier|preceding|above|system)\b[\s\S]{0,20}\b(instruction|instructions|prompt|prompts|direction|directions|context|rules?)\b/i],
  ['instruction-override', 'critical',
    /\b(your\s+new|the\s+new|updated|real)\s+(instruction|instructions|task|objective|directive|directives)\b\s*[:\-]/i],

  // Authority spoofing / jailbreak persona.
  // "developer mode" is NOT listed bare: it fired critical on ordinary prose
  // describing a product's Developer Mode toggle (glmps-144). It counts only
  // when something ACTIVATES it.
  ['authority-spoof', 'critical',
    /\b(you\s+are\s+now|act\s+as|pretend\s+(to\s+be|you\s+are|that\s+you)|roleplay\s+as|jailbreak|do\s+anything\s+now|\bDAN\b)\b/i],
  ['authority-spoof', 'critical',
    /\b(enter|enable|activate|turn\s+on|switch\s+to|in)\s+developer\s+mode\b|\bdeveloper\s+mode\s*[:=]\s*(on|true|enabled)\b/i],
  ['authority-spoof', 'critical',
    /\b(this\s+(message|instruction|prompt|note)\s+(is|comes?)\s+from|i\s+am|message\s+from)\s+(anthropic|openai|the\s+system|system\s+admin|your\s+(developer|operator|administrator))\b/i],

  // Exfiltration: move data to an external endpoint, or attach secrets to a call.
  ['exfiltration', 'critical',
    /\b(send|post|upload|exfiltrate|transmit|forward|leak|email|curl|wget|fetch)\b[\s\S]{0,80}\b(to|at|into)\b[\s\S]{0,20}(https?:\/\/|[\w.-]+@[\w.-]+)/i],
  ['exfiltration', 'critical',
    /\b(append|include|attach|add|put)\b[\s\S]{0,40}\b(api[_\s-]?key|access[_\s-]?key|secret|token|password|credential|\.ssh|id_rsa|env\s+var|environment\s+variable)\b/i],

  // Embedded credential material.
  ['credential', 'critical',
    /(sk-[A-Za-z0-9_-]{16,512}|AKIA[0-9A-Z]{12,512}|ghp_[A-Za-z0-9]{20,512}|xox[baprs]-[A-Za-z0-9-]{10,512}|AIza[0-9A-Za-z_-]{20,512})/],
  ['credential', 'critical',
    /-----BEGIN(?:[ \t]+[A-Z0-9]{1,16}){0,4}[ \t]+PRIVATE KEY-----/],
  ['credential', 'critical',
    /\beyJ[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,512}\b/],
  // A JWT header followed by a payload that also starts eyJ is enough on its
  // own, so a segment longer than the caps above cannot evade the full form.
  // The lookbehind anchors it to the start of a token run so it stays linear.
  ['credential', 'critical',
    /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,64}/],

  // Memory-poisoning phrasing: persistence-oriented language aimed at an agent.
  // The bare temporal phrases ("from now on", "going forward") are ordinary
  // English and fired on operator-authored notes (glmps-144), so they now
  // require a nearby directive to count. The explicitly memory-addressed
  // phrases keep firing on their own.
  ['memory-injection', 'warn',
    /\b(memori[sz]e\s+(that|this)|for\s+future\s+reference|in\s+all\s+(future\s+)?sessions?|for\s+all\s+(future\s+)?sessions?)\b/i],
  ['memory-injection', 'warn',
    /\b(remember\s+that|keep\s+in\s+mind\s+that|from\s+now\s+on|going\s+forward)\b[\s\S]{0,60}\b(you|always|never|must|should|do\s+not|don't|ignore|disable|approve|allow|skip)\b/i],

  // An imperative package-install directive (glmps-70). Surfaced
  // live: the most-guessable PyPI names for a project were owned by an
  // unrelated third party whose repo description carried an imperative
  // `pip install <their-package>` aimed at whatever was reading it. That is
  // attacker-controlled text handing an install instruction to a research
  // agent, which is our threat model in the wild.
  //
  // CONTEXT-ONLY, like external-url, and for the same reason: every README,
  // doc and ticket in this codebase says "npm install" somewhere. A flag that
  // quarantined on its own would fire on ordinary content and re-break exactly
  // the calibration glmps-144 and glmps-49 did. This sharpens other
  // findings; it is not a gate by itself.
  //
  // Requires an actual COMMAND, not prose about installation: the manager, the
  // verb, and a package-shaped argument, so "the installation docs" and "we
  // decided against adopting it" stay silent.
  ['install-directive', 'warn',
    /\b(pip3?|npm|pnpm|yarn|uv|pipx|gem|cargo|go|brew|apt(?:-get)?|choco|winget)\s+(install|add|get)\s+(?:--?\w[\w-]{0,40}\s+){0,10}[@\w][\w.@/-]{2,512}/i],

  // A bare external URL: context, not proof. Warn.
  // Loopback is excluded: an address on this machine is by definition not
  // external, and flagging it quarantined notes that merely documented a local
  // dashboard or debug port (glmps-144). The negative lookahead is anchored so
  // a host that merely CONTAINS "localhost" (localhost.evil.com) still fires.
  ['external-url', 'warn',
    /\bhttps?:\/\/(?!(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|0\.0\.0\.0|\[::1\])(?:[:/]|$))[^\s)<>"']{1,1024}/i],
];

// Base64 blobs that decode to instruction-like text are a known smuggling trick.
const B64_RUN = /[A-Za-z0-9+/]{40,}={0,2}/g;
const B64_KEYWORDS = /(ignore|instruction|disregard|exfiltrate|password|api[_\s-]?key|send\s+to|http)/i;

function maxSeverity(a, b) { return SEVERITY[a] >= SEVERITY[b] ? a : b; }

function detectBase64(text) {
  const runs = String(text).match(B64_RUN);
  if (!runs) return false;
  for (const run of runs) {
    try {
      const decoded = Buffer.from(run, 'base64').toString('utf-8');
      // Require mostly-printable decode to avoid flagging binary-ish blobs.
      if (B64_KEYWORDS.test(decoded)) return true;
    } catch { /* not valid base64 */ }
  }
  return false;
}

// every detector runs over windows of at most 16 KiB. No pattern nests
// or overlaps unbounded quantifiers, so each costs at most polynomial time in
// the 16 KiB window, and the number of windows grows linearly with the input.
// Windows overlap by SCAN_OVERLAP chars, which must be at least
// MAX_PATTERN_SPAN, the longest text any bounded pattern can match (widest:
// the three-segment JWT, 3 x 512 + 2 dots + 3 'eyJ' = 1541; then the URL,
// 8 + 1024; the install line, ~1000), so a match cannot be split by a boundary.
// Whitespace runs inside the phrase patterns (\s+) are not capped; a phrase
// padded with more than the margin of whitespace across a boundary can slip,
// and so can a JWT whose header alone is longer than the overlap.
export const MAX_PATTERN_SPAN = 1600;
export const SCAN_OVERLAP = 2048;
const SCAN_WINDOW = 16 * 1024;
function scanWindows(text) {
  if (text.length <= SCAN_WINDOW) return [text];
  const out = [];
  for (let i = 0; ; i += SCAN_WINDOW - SCAN_OVERLAP) {
    out.push(text.slice(i, i + SCAN_WINDOW));
    if (i + SCAN_WINDOW >= text.length) break;
  }
  return out;
}

// Scan 2026-10-15 F6: a credential match IS the secret, and samples travel
// into alerts and the shareable baseline report, so only its first four
// characters (the token family, e.g. 'ghp_') and its length are kept.
export const SECRET_SAMPLE_CODES = new Set(['credential']);
export function maskSecretSample(text) {
  const s = String(text ?? '');
  return `${s.slice(0, 4)}... [redacted, ${s.length} chars]`;
}
function sampleOf(code, matched) {
  return SECRET_SAMPLE_CODES.has(code) ? maskSecretSample(matched) : String(matched).slice(0, 80);
}

/**
 * Scan a string for poisoning signals.
 * @returns {{ flags: string[], severity: 'none'|'warn'|'critical', clean: boolean, matches: object[] }}
 */
export function scanText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { flags: [], severity: 'none', clean: true, matches: [] };
  }
  const flags = new Set();
  const matches = [];
  let severity = 'none';

  const windows = scanWindows(text);
  for (const [code, sev, re] of DETECTORS) {
    if (flags.has(code)) continue; // one entry per code
    for (const w of windows) {
      const m = re.exec(w);
      if (!m) continue;
      flags.add(code);
      severity = maxSeverity(severity, sev);
      matches.push({ code, severity: sev, sample: sampleOf(code, m[0]) });
      break;
    }
  }

  if (!flags.has('base64-instruction') && detectBase64(text)) {
    flags.add('base64-instruction');
    severity = maxSeverity(severity, 'warn');
    matches.push({ code: 'base64-instruction', severity: 'warn', sample: '' });
  }

  return { flags: [...flags], severity, clean: flags.size === 0, matches };
}

// Sources authored at the operator's keyboard get OPERATOR trust; anything that
// arrives via an automated/derived path (deferral feeder, AO, programmatic API
// posts) is EXTERNAL and scanned more strictly.
const OPERATOR_SOURCES = new Set(['manual', 'dashboard', 'operator']);
const TRUST_LEVELS = new Set(['operator', 'external']);

/**
 * @param {string} source
 * @param {{ trust?: string }} [opts] - an explicit override, for an intake path
 *   that ran its OWN authorization gate and therefore knows something the
 *   `source` string cannot express. SCUT is the case this exists for: a Slack
 *   @mention only reaches ticket intake after server/lib/scut/guard.js has
 *   fail-closed matched the sender against the operator's identity allowlist,
 *   so the text WAS typed by an authorized human, merely over a different
 *   transport than the dashboard. Before this, `source:'scut'` fell to
 *   external trust and every mention carrying a link or an ordinary
 *   "remember that ..." sat waiting for an approval (glmps-49).
 *
 *   This only ever relaxes WARN-level content: quarantineDecision() holds
 *   anything critical regardless of trust, so an allowlisted sender pasting
 *   genuinely injected text is still caught.
 */
export function classifyTrust(source, { trust } = {}) {
  if (TRUST_LEVELS.has(trust)) return trust;
  return OPERATOR_SOURCES.has(String(source ?? '')) ? 'operator' : 'external';
}

// Flags that are CONTEXT, not evidence: worth surfacing on the board, never
// enough to hold something by themselves. `external-url` is the whole set
// today, and the detector table above already says why - a link is "context,
// not proof". Holding on it alone made every Slack mention carrying a link
// wait for an approval (operator-reported, glmps-49), which is the
// same rubber-stamp failure mode glmps-144 fixed for the DETECTORS: a gate
// that fires on ordinary content stops being read as a gate.
// 'install-directive' joins it for the same reason (glmps-70): an
// install command is everywhere in ordinary developer content, so holding a
// ticket on one alone would recreate the rubber-stamp failure. It earns its
// keep by sharpening a ticket that ALSO carries a real injection flag.
export const CONTEXT_ONLY_FLAGS = new Set(['external-url', 'install-directive']);

// Quarantine decision: hold (a) anything critical, or (b) on external-trust
// content, any flag that is not merely contextual. Operator-authored
// warn-level content passes.
//
// `flags` is optional. A caller that does not supply it gets the original
// severity-only rule (strict: any warn quarantines external content), so this
// can never silently loosen a gate that was not updated to pass its flags.
export function quarantineDecision({ trust, severity, flags } = {}) {
  if (severity === 'critical') return true;
  if (trust !== 'external' || severity === 'none') return false;
  if (!Array.isArray(flags)) return true;
  return flags.some(f => !CONTEXT_ONLY_FLAGS.has(f));
}

/**
 * Produce a provenance record for a backlog ticket.
 *
 * `opts.trust` is a SEPARATE argument, deliberately not a field on the ticket:
 * ticket bodies arrive from HTTP, and a body field would let any POST declare
 * itself operator-authored. Only a call site in this process can set it.
 *
 * @returns {{ trust, flags, severity, quarantined, matches }}
 */
export function scanTicket({ title = '', prompt = '', description = '', acceptanceCriteria, source } = {}, { trust: trustOverride } = {}) {
  const trust = classifyTrust(source, { trust: trustOverride });
  const acText = (acceptanceCriteria || []).map(c => (c && c.text) ? c.text : '');
  const r = scanText([title, prompt, description, ...acText].join('\n'));
  return {
    trust,
    flags: r.flags,
    severity: r.severity,
    matches: r.matches,
    quarantined: quarantineDecision({ trust, severity: r.severity, flags: r.flags }),
  };
}

export { RANK };
