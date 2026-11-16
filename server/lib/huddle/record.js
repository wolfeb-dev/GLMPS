// server/lib/huddle/record.js
// The four-part record an ended huddle leaves behind: problem statement,
// decisions (each with the seat that argued against it), open questions, next
// actions. Built from the decide extraction, stored in the state dir, and
// turned into a card body or a spec draft. Nothing here files anything: the
// server does that, and only when the operator presses a button or says the
// work command.
import fs from 'node:fs';
import path from 'node:path';

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const recordFile = (stateDir, id) => path.join(stateDir, 'huddle-records', `${id}.json`);

export function buildRecord({ id, startedAt, now = new Date().toISOString(), extracted, summary = '' }) {
  const against = extracted.against ?? [];
  return {
    id,
    startedAt,
    savedAt: now,
    summary,
    problem: extracted.problem ?? '',
    decisions: extracted.decisions.map((text, i) => ({ text, against: against[i] ?? '' })),
    open: extracted.open,
    actions: extracted.actions,
  };
}

export function saveRecord(stateDir, record) {
  if (!SAFE_ID.test(String(record.id))) throw new Error('unsafe huddle id');
  const file = recordFile(stateDir, record.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}

export function loadRecord(stateDir, id) {
  if (!SAFE_ID.test(String(id))) return null;
  try { return JSON.parse(fs.readFileSync(recordFile(stateDir, id), 'utf8')); } catch { return null; }
}

const bullets = (items) => items.map((x) => `- ${x}`).join('\n');
const actionLine = (a) => (a.detail ? `${a.title}: ${a.detail}` : a.title);
const decisionLine = (d) => (d.against ? `${d.text} (argued against by ${d.against})` : d.text);
const headline = (r) => r.problem || r.decisions[0]?.text || r.actions[0]?.title || 'untitled';

export function recordCard({ record, project }) {
  const sections = [
    'Build from this huddle record. Write a spec with to-spec if one is needed, then implement it.',
    record.problem ? `Problem:\n${record.problem}` : null,
    record.decisions.length ? `Decisions:\n${bullets(record.decisions.map(decisionLine))}` : null,
    record.actions.length ? `Next actions:\n${bullets(record.actions.map(actionLine))}` : null,
    record.open.length ? `Still open (ask the operator before assuming):\n${bullets(record.open)}` : null,
  ].filter(Boolean);
  return {
    project,
    title: `Huddle ${record.id}: ${headline(record)}`.slice(0, 120),
    prompt: sections.join('\n\n'),
    source: 'huddle',
    origin: { via: 'huddle', huddleId: record.id },
    acceptanceCriteria: record.decisions.map((d, i) => ({ text: `AC-${i + 1} ${d.text}`, done: false })),
  };
}

export function draftSpec(record) {
  const none = '- (none)';
  return [
    `# Spec draft: ${headline(record)}`,
    `From huddle ${record.id}, saved ${record.savedAt}. A draft: the operator edits it before it is committed.`,
    `## Problem\n${record.problem || '(not stated in the huddle)'}`,
    `## Decisions\n${record.decisions.length ? bullets(record.decisions.map(decisionLine)) : none}`,
    `## Open questions\n${record.open.length ? bullets(record.open) : none}`,
    `## Next actions\n${record.actions.length ? bullets(record.actions.map(actionLine)) : none}`,
    `## Acceptance criteria\n${record.decisions.length ? record.decisions.map((d, i) => `- [ ] AC-${i + 1} ${d.text}`).join('\n') : none}`,
  ].join('\n\n') + '\n';
}
