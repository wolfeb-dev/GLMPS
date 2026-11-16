// server/lib/observability/provider-spend.js
// Per-provider spend over a window, split from the usage ndjson the
// statusline and CLI taps already write (<stateDir>/usage/<date>.ndjson).
// Reads only; collects nothing new. Values in those records are cumulative per
// session, so a window's figure is the session's last value inside the window
// minus its last value before it, clamped at 0 (same method as usage-store).
import fs from 'node:fs';
import path from 'node:path';

const LABELS = { anthropic: 'Anthropic', google: 'Google', openai: 'OpenAI', other: 'Other' };

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// The model names the vendor; the tool is only the fallback because a
// multi-vendor tool (Copilot, OpenCode) says nothing about who billed the call.
export function providerOf({ model, tool } = {}) {
  const m = String(model ?? '').toLowerCase();
  if (/claude|opus|sonnet|haiku/.test(m)) return 'anthropic';
  if (/gemini|gemma/.test(m)) return 'google';
  if (/gpt|codex|\bo[134]\b|\bo[134]-/.test(m)) return 'openai';
  const t = String(tool ?? '').toLowerCase();
  if (!t || t === 'claude-code') return 'anthropic';
  if (t === 'antigravity' || t === 'agy-cli' || t === 'gemini-cli') return 'google';
  if (t === 'codex-cli' || t === 'codex') return 'openai';
  return 'other';
}

function tokensOf(r) { return (num(r.input) ?? 0) + (num(r.output) ?? 0); }

export function computeProviderSpend(records, { from, to }) {
  const bySid = new Map();
  for (const r of records ?? []) {
    if (!r || typeof r.sid !== 'string' || !r.sid) continue;
    const at = num(r.capturedAt);
    if (at == null || at > to) continue;
    let s = bySid.get(r.sid);
    if (!s) { s = { before: null, inside: null }; bySid.set(r.sid, s); }
    const slot = at < from ? 'before' : 'inside';
    if (!s[slot] || at >= s[slot].capturedAt) s[slot] = r;
  }

  const acc = new Map();
  for (const s of bySid.values()) {
    if (!s.inside) continue;
    const id = providerOf(s.inside);
    let p = acc.get(id);
    if (!p) { p = { id, label: LABELS[id], spendUsd: null, tokens: 0, sessions: 0 }; acc.set(id, p); }
    p.sessions += 1;
    p.tokens += Math.max(0, tokensOf(s.inside) - (s.before ? tokensOf(s.before) : 0));
    const cost = num(s.inside.costUsd);
    if (cost != null) {
      const prior = s.before ? (num(s.before.costUsd) ?? 0) : 0;
      p.spendUsd = (p.spendUsd ?? 0) + Math.max(0, cost - prior);
    }
  }
  return [...acc.values()].sort((a, b) =>
    (b.spendUsd ?? -1) - (a.spendUsd ?? -1) || b.tokens - a.tokens);
}

export function readProviderSpend(stateDir, { hours = 168, now = Date.now() } = {}) {
  const span = Number.isFinite(hours) && hours > 0 ? hours : 168;
  const to = now;
  const from = to - span * 3600 * 1000;
  const out = { from: new Date(from).toISOString(), to: new Date(to).toISOString(), providers: [] };
  const dir = path.join(stateDir, 'usage');
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson')); } catch { return out; }
  const records = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(dir, f), 'utf-8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let r;
      try { r = JSON.parse(t); } catch { continue; }
      if (!r || typeof r !== 'object') continue;
      const at = num(r.capturedAt) ?? num(r.ts);
      if (at == null) continue;
      records.push({ ...r, capturedAt: at });
    }
  }
  out.providers = computeProviderSpend(records, { from, to });
  return out;
}
