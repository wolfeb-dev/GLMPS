// server/lib/observability/git-events.js
// Detect 'saved work' git operations in a shell command string.
// Returns { kind:'git', lane:'context', label, gitOp } or null.
//
// the chained `[^\n]*` patterns backtracked in cubic time on a long line
// of repeated words. The command is capped at 4096 chars and each "A ... B
// ... C on one line" test is done by finding each word AFTER the previous
// match (one left-to-right pass per word), which is linear.
const MAX_CMD = 4096;

function inOrder(line, patterns) {
  let from = 0;
  for (const p of patterns) {
    const re = new RegExp(p, 'g');
    re.lastIndex = from;
    const m = re.exec(line);
    if (!m) return false;
    from = m.index + m[0].length;
  }
  return true;
}

function classifyBounded(c) {
  const lines = c.split('\n');
  const anyLine = (patterns) => lines.some((l) => inOrder(l, patterns));
  if (anyLine(['\\bgit\\s', '\\bcommit\\b'])) {
    const m = c.match(/-m\s+"([^"\n]+)"|-m\s+'([^'\n]+)'|--message[= ]"?([^"\n]+)"?/);
    const msg = m ? (m[1] ?? m[2] ?? m[3] ?? '').trim() : '(commit)';
    return { kind: 'git', lane: 'context', gitOp: 'commit', label: 'commit: ' + msg.slice(0, 100) };
  }
  if (anyLine(['\\bgit\\s', '\\bpush\\b'])) {
    // Skip leading flags (e.g. --force-with-lease) to capture remote + branch.
    const at = c.search(/push\s/);
    const toks = at === -1 ? [] : c.slice(at).split(/\s+/).slice(1).filter(Boolean);
    while (toks.length && toks[0].startsWith('-')) toks.shift();
    return { kind: 'git', lane: 'context', gitOp: 'push', label: toks.length >= 2 ? `push \u2192 ${toks[0]}/${toks[1]}` : 'push' };
  }
  if (anyLine(['\\bgh\\b', '\\bpr\\b', '\\bcreate\\b'])) {
    return { kind: 'git', lane: 'context', gitOp: 'pr', label: 'gh pr create' };
  }
  return null;
}

// A command over the cap is still a git event if its head classifies, or if
// its last MAX_CMD chars hold a state-changing keyword: padding must not hide
// a destructive command. It is marked truncated so consumers know the label
// is a best effort.
const TAIL_KEYWORD = /\b(push|commit|reset|rebase)\b/;
export function classifyGit(cmd) {
  if (typeof cmd !== 'string') return null;
  const full = cmd.trim();
  if (full.length <= MAX_CMD) return classifyBounded(full);
  const head = full.slice(0, MAX_CMD);
  const hit = classifyBounded(head);
  if (hit) return { ...hit, truncated: true };
  const tail = full.slice(-MAX_CMD);
  for (const l of tail.split('\n')) {
    if (!inOrder(l, ['\\bgit\\s'])) continue;
    const m = TAIL_KEYWORD.exec(l);
    if (m) return { kind: 'git', lane: 'context', gitOp: m[1], label: `git ${m[1]} (truncated)`, truncated: true };
  }
  if (/\bgit\s/.test(head) || /\bgit\s/.test(tail)) {
    return { kind: 'git', lane: 'context', gitOp: 'git', label: 'git (truncated)', truncated: true };
  }
  return null;
}
