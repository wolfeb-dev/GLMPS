// Correction signals from a raw Claude Code transcript: operator rejections of
// a tool call (tool-denied) and one error repeated until the session pivoted to
// a different call (tool-error-loop). Spec: docs/specs/2026-10-28-correction-signals.md
// in wolfeb-dev/glmps-2.0, decisions D39. Returns [{ code, severity, message }]
// in the same shape as transcript-gaps.js; per session only, no store access.
// Pure function over JSONL lines. Raw side of the learning boundary: it must
// never import the memory distiller (architecture-memory-learning-boundary.test.js).
import crypto from 'node:crypto';

// Calls whose rejection means "stop waiting", not "that call was wrong".
export const WAIT_CALLS = ['/api/scut/park'];

// Rejecting a question is declining the question, not correcting a tool.
const NOT_TOOLS = new Set(['AskUserQuestion']);

const REJECTED_MARKER = 'User rejected tool use';

// Results that are a guard or the harness doing its job (spec guard lines 5-7).
// Newer Claude Code also marks every permission denial (hook, deny rule,
// classifier, safety check) with a top-level toolDenialKind, and a hook's deny
// reason then arrives without the "PreToolUse:" prefix, so the record field is
// checked first and these texts cover transcripts that predate it.
const EXCLUDED_ERRORS = [
  (t) => /^PreToolUse:\S+ hook error/.test(t),
  (t) => t.includes('Permission for this action was denied by the Claude Code auto mode classifier'),
  (t) => t.includes('auto mode cannot determine the safety'),
  (t) => t.startsWith('<tool_use_error>File has not been read yet'),
  (t) => t.includes('File has been modified since read'),
  (t) => t.startsWith('<tool_use_error>InputValidationError'),
];

const LOOP_MIN_FAILS = 3;
const DENY_MIN_REJECTIONS = 2;
const ERROR_LINE_MAX = 100;
const FINGERPRINT_PART_MAX = 300;
const MESSAGE_MAX = 2000;

const WIN_PATH_RE = /(?<![A-Za-z])[A-Za-z]:[\\/][^\s'"`]*/g;
const POSIX_PATH_RE = /(?<=^|[\s'"`(=])\/[^\s'"`]+/g;
const ENV_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function normalizePaths(s) {
  return String(s).replace(WIN_PATH_RE, 'P').replace(POSIX_PATH_RE, 'P');
}

function parseLines(input) {
  if (input == null) return [];
  const raw = Array.isArray(input) ? input : String(input).split('\n');
  const parsed = [];
  for (const line of raw) {
    const s = String(line ?? '').trim();
    if (!s) continue;
    try {
      parsed.push(JSON.parse(s));
    } catch {
      // skip unparseable
    }
  }
  return parsed;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => (typeof c?.text === 'string' ? c.text : '')).join('\n');
  return '';
}

function extensionOf(filePath) {
  const base = String(filePath ?? '').split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

export function callFingerprint(name, input = {}) {
  const tool = String(name ?? '');
  if (tool === 'Bash') {
    const tokens = String(input?.command ?? '').trim().split(/\s+/).filter(Boolean);
    while (tokens.length && ENV_PREFIX_RE.test(tokens[0])) tokens.shift();
    const head = normalizePaths(tokens.slice(0, 2).join(' ')).slice(0, FINGERPRINT_PART_MAX);
    return head ? `${tool} ${head}` : tool;
  }
  if (tool === 'Edit' || tool === 'Write' || tool === 'Read') {
    const ext = extensionOf(input?.file_path);
    return ext ? `${tool} ${ext}` : tool;
  }
  return tool;
}

// null when the result has no usable error line (spec guard line 9).
export function errorFingerprint(callFp, content) {
  const text = typeof content === 'string' ? content : resultText(content);
  const first = text.split('\n').map(l => l.trim()).find(l => l && !/^Exit code \d+$/.test(l));
  if (!first) return null;
  const line = normalizePaths(first).replace(/\d+/g, 'N').trim().slice(0, ERROR_LINE_MAX);
  return line ? `${callFp} | ${line}` : null;
}

export function correctionId(fingerprint) {
  return crypto.createHash('sha1').update(String(fingerprint)).digest('hex').slice(0, 12);
}

function isWaitCall(use) {
  if (use.name !== 'Bash') return false;
  const cmd = String(use.input?.command ?? '');
  return WAIT_CALLS.some(w => cmd.includes(w));
}

function isExcludedError(text) {
  const t = text.trimStart();
  return EXCLUDED_ERRORS.some(test => test(t));
}

const cap = (s) => (s.length > MESSAGE_MAX ? s.slice(0, MESSAGE_MAX) : s);

export function scanTranscriptForCorrections(lines) {
  const uses = new Map();
  const rejections = new Map(); // callFp -> { tool, count }
  const loops = new Map(); // errorFp -> { tool, callFp, line, count, thirdAt }
  const successes = []; // { tool, callFp, at }
  let at = 0;

  for (const obj of parseLines(lines)) {
    const content = obj?.message?.content;
    if (!Array.isArray(content)) continue;
    if (obj.type === 'assistant') {
      for (const c of content) if (c?.type === 'tool_use' && c.id) uses.set(c.id, c);
      continue;
    }
    if (obj.type !== 'user') continue;
    for (const r of content) {
      if (r?.type !== 'tool_result') continue;
      const use = uses.get(r.tool_use_id);
      if (!use) continue;
      at++;
      const tool = String(use.name ?? '');
      const callFp = callFingerprint(tool, use.input);
      const isError = r.is_error === true;

      // S1 needs the structural marker; quoting the rejection text never counts.
      if (isError && obj.toolUseResult === REJECTED_MARKER) {
        if (NOT_TOOLS.has(tool) || isWaitCall(use)) continue;
        const row = rejections.get(callFp) ?? { tool, count: 0 };
        row.count++;
        rejections.set(callFp, row);
        continue;
      }

      if (!isError) {
        successes.push({ tool, callFp, at });
        continue;
      }

      if (obj.toolDenialKind != null) continue;
      const text = resultText(r.content);
      if (isExcludedError(text)) continue;
      const efp = errorFingerprint(callFp, text);
      if (!efp) continue;
      const row = loops.get(efp) ?? { tool, callFp, line: efp.slice(callFp.length + 3), count: 0, thirdAt: null };
      row.count++;
      if (row.count === LOOP_MIN_FAILS) row.thirdAt = at;
      loops.set(efp, row);
    }
  }

  const gaps = [];
  for (const [callFp, row] of rejections) {
    if (row.count < DENY_MIN_REJECTIONS) continue;
    gaps.push({
      code: `tool-denied:${correctionId(callFp)}`,
      severity: 'warn',
      message: cap(`Operator rejected ${row.tool} call "${callFp}" ${row.count}x in this session.`),
    });
  }
  for (const [efp, row] of loops) {
    if (row.count < LOOP_MIN_FAILS) continue;
    const pivot = successes.find(s => s.at > row.thirdAt && s.tool === row.tool && s.callFp !== row.callFp);
    if (!pivot) continue;
    gaps.push({
      code: `tool-error-loop:${correctionId(efp)}`,
      severity: 'info',
      message: cap(`${row.tool} call "${row.callFp}" failed ${row.count}x with "${row.line}", then "${pivot.callFp}" succeeded.`),
    });
  }
  return gaps;
}
