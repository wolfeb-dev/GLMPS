// Pure core of hooks/park-wake-context.js.
//
// A PostToolUse hook from a settings file can attach classifierContext, but the
// classifier treats it as unverified background, never as user intent (that
// needs a real user turn: see scut.wakeHandoff). So this only says where a
// result came from, and must never copy the note: the docs warn against putting
// untrusted text in it.
export const CONTEXT_TEXT = "This result is a GLMPS park-loop reply relayed by the local GLMPS server from the operator's Slack thread for this card.";

const TOOLS = new Set(['Bash', 'BashOutput', 'TaskOutput']);

function responseText(r) {
  if (typeof r === 'string') return r;
  if (!r || typeof r !== 'object') return '';
  return ['stdout', 'output', 'content', 'text', 'result']
    .map((k) => (typeof r[k] === 'string' ? r[k] : ''))
    .join('\n');
}

// Every JSON object that starts at an `{"action"` in the text. A balanced scan
// that respects strings, because a note may contain braces and the surrounding
// output (curl progress, a status line) is not ours.
function* actionObjects(text) {
  let from = 0;
  for (;;) {
    const start = text.indexOf('{"action"', from);
    if (start < 0) return;
    let depth = 0; let inStr = false; let esc = false; let end = -1;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { end = i; break; }
    }
    if (end < 0) return;
    try { yield JSON.parse(text.slice(start, end + 1)); } catch { /* not JSON: keep scanning */ }
    from = end + 1;
  }
}

export function parkWakeContext(inp) {
  try {
    if (!inp || !TOOLS.has(inp.tool_name)) return null;
    const command = inp.tool_input?.command;
    // Bash carries its command, so it must be a park poll (the poll runs in the
    // foreground). BashOutput/TaskOutput carry none; accepted as a fallback,
    // though classifierContext on read-only lookups may be discarded.
    if (typeof command === 'string' && !command.includes('/api/scut/park')) return null;
    for (const obj of actionObjects(responseText(inp.tool_response))) {
      if (obj?.action === 'wake' && obj.provenance === 'operator') {
        return { hookSpecificOutput: { hookEventName: 'PostToolUse', classifierContext: CONTEXT_TEXT } };
      }
    }
  } catch { /* fail open */ }
  return null;
}
