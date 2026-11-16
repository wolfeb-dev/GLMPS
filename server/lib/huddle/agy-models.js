// The model names agy 1.4.7 accepts (`agy models`, verified 2026-10-24). The
// desktop shell keeps its own copy (apps/shell/src/lib/agy-runner.js) because
// it must not import server code; a parity test keeps the two equal. This is
// an allowlist, so it stays pinned; a seat whose model agy later retires is
// moved by resolveRetiredModel to one agy still lists.
export const AGY_MODELS = Object.freeze([
  'Gemini 4 Argon (Medium)',
  'Gemini 4 Argon (High)',
  'Gemini 4 Argon (Low)',
  'Gemini 3.8 Flash (High)',
  'Gemini 3.8 Flash (Medium)',
  'Gemini 3.8 Flash (Low)',
  'Claude Opus 5.5 (Low)',
  'Claude Opus 5.5 (Medium)',
  'Claude Opus 5.5 (High)',
  'Claude Sonnet 5.5 (Low)',
  'Claude Sonnet 5.5 (Medium)',
  'Claude Sonnet 5.5 (High)',
  'GPT-OSS 120B (Medium)',
]);
// "Gemini <version> <name> (<tier>)". The operator wants the newest model by
// default (card glmps-2-0-164), so defaults derive from this rule rather than
// a pinned name; the shell's copy in agy-runner.js must stay identical.
const GEMINI_NAME = /^Gemini (\d+(?:\.\d+)*) .+ \((High|Medium|Low)\)$/;
const cmpVersion = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
};
export function newestGeminiModel(names, tier = 'High') {
  let best = null;
  for (const n of Array.isArray(names) ? names : []) {
    const m = typeof n === 'string' ? GEMINI_NAME.exec(n) : null;
    if (!m || m[2] !== tier) continue;
    if (!best || cmpVersion(m[1], best.v) > 0) best = { v: m[1], name: n };
  }
  return best?.name ?? null;
}

export const AGY_PROMPT_MAX = 32000;
export const AGY_RESULT_MAX = 4000;

// agy rejects an unknown --model with "... is not recognized as a known model"
// followed by "Available models:" and one indented name per line. The error
// reaches the seat through a tail() that may cut the head off, so the listed
// names are what is relied on. Only allowlisted names are returned.
export function retiredModelError(message, model) {
  const s = String(message ?? '');
  const listed = [...new Set(s.split(/\r?\n/).map((l) => l.trim()).filter((l) => AGY_MODELS.includes(l)))];
  const said = /not recognized as a known model/.test(s);
  if (!said && listed.length < 2) return null;
  if (listed.includes(model)) return null;
  return { available: listed.length ? listed : AGY_MODELS.filter((m) => m !== model) };
}

const words = (m, n) => String(m ?? '').split(' ').slice(0, n).join(' ');
const tier = (m) => (/\(Medium\)/.test(m) ? 0 : /\(Low\)/.test(m) ? 1 : 2);

// Closest kin first (Claude Sonnet stays Sonnet, then Claude; a Gemini seat
// stays Gemini), Medium before Low before High (a second view must be quick),
// never a model another seat already holds.
export function resolveRetiredModel(model, available, avoid = []) {
  const taken = new Set(avoid);
  const free = (available ?? []).filter((m) => AGY_MODELS.includes(m) && m !== model && !taken.has(m));
  const byTier = (list) => [...list].sort((a, b) => tier(a) - tier(b));
  for (const n of [2, 1]) {
    const kin = byTier(free.filter((m) => words(m, n) === words(model, n)))[0];
    if (kin) return kin;
  }
  return byTier(free)[0] ?? null;
}
