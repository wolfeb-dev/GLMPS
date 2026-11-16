// Operator phrases -> Pocock skills. The vocabulary lives in
// docs/agents/skill-cues.md and nowhere else; this module only parses and
// matches it. Every failure resolves to an empty vocabulary so a launch never
// fails on a cue (fail open).
import fs from 'node:fs';
import path from 'node:path';

const MAX_SKILLS = 3;
const EMPTY = () => ({ cues: [], operatorCues: [], defaults: {} });

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function parseSkillCues(markdown) {
  const out = EMPTY();
  if (typeof markdown !== 'string') return out;
  let table = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) { table = null; continue; }
    const c = cells(line);
    if (/^skill$/i.test(c[0]) && /^phrases$/i.test(c[1] ?? '')) { table = 'cues'; continue; }
    if (/^skill$/i.test(c[0]) && /^words$/i.test(c[1] ?? '')) { table = 'operatorCues'; continue; }
    if (/^card class$/i.test(c[0]) && /^skill$/i.test(c[1] ?? '')) { table = 'defaults'; continue; }
    if (!table || /^:?-+:?$/.test(c[0])) continue;
    if ((table === 'cues' || table === 'operatorCues') && c[0] && c[1]) {
      const phrases = c[1].split(',').map((p) => p.trim()).filter(Boolean);
      if (phrases.length) out[table].push({ skill: c[0], phrases });
    } else if (table === 'defaults' && c[0] && c[1]) {
      out.defaults[c[0].toLowerCase()] = c[1];
    }
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Hyphen and whitespace are interchangeable inside a phrase. At its edges a
// hyphen or dot joined to a word is not a boundary: "data-research" and
// "research-scan.js" are names, not cues. A sentence-ending dot still is.
function phraseRe(phrase) {
  const body = phrase.trim().split(/[\s-]+/).filter(Boolean).map(escapeRe).join('[\\s-]+');
  return new RegExp(`(?<![A-Za-z0-9_.-])${body}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, 'i');
}

// `operator` says the operator wrote `text` (a Slack card or reply). Only then
// do the operator words count: agent-written cards use the same words as names.
export function pickSkills(text, vocab, { taskClass, operator = false } = {}) {
  const t = typeof text === 'string' ? text : '';
  const first = new Map();
  const entries = [...(vocab?.cues ?? []), ...(operator ? vocab?.operatorCues ?? [] : [])];
  for (const { skill, phrases } of entries) {
    for (const p of phrases) {
      const m = phraseRe(p).exec(t);
      if (m && !(first.get(skill) <= m.index)) first.set(skill, m.index);
    }
  }
  if (first.size) {
    const hits = [...first].sort((a, b) => a[1] - b[1]);
    return { skills: hits.slice(0, MAX_SKILLS).map(([skill]) => skill), via: 'cue' };
  }
  const def = vocab?.defaults?.[String(taskClass ?? 'other').toLowerCase()] ?? vocab?.defaults?.other;
  // An unknown class gets no suggestion rather than the `other` one.
  const known = taskClass == null || Object.hasOwn(vocab?.defaults ?? {}, String(taskClass).toLowerCase());
  // '-' in the class table means the routed agent is the method: no skill.
  if (def && def !== '-' && known) return { skills: [def], via: 'class' };
  return { skills: [], via: 'none' };
}

// Wake notes carry only what the operator said: no class default.
export function wakeSkills(note, vocab) {
  const r = pickSkills(note, { cues: vocab?.cues ?? [], operatorCues: vocab?.operatorCues ?? [], defaults: {} }, { operator: true });
  return r.via === 'cue' ? r.skills : [];
}

// An external note (the merge reviewer, the queue) is not the operator's
// wording, and its findings routinely contain cue phrases.
export function withWakeSkills(reply, vocab) {
  if (reply?.provenance !== 'operator') return reply;
  const skills = wakeSkills(reply?.note, vocab);
  return skills.length ? { ...reply, skills } : reply;
}

const cache = new Map();

export function loadSkillCues(repoRoot) {
  try {
    if (!repoRoot) return EMPTY();
    const file = path.join(repoRoot, 'docs', 'agents', 'skill-cues.md');
    const mtimeMs = fs.statSync(file).mtimeMs;
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.vocab;
    const vocab = parseSkillCues(fs.readFileSync(file, 'utf8'));
    cache.set(file, { mtimeMs, vocab });
    return vocab;
  } catch { return EMPTY(); }
}
