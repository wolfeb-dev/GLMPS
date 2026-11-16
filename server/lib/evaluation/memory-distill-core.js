// server/lib/evaluation/memory-distill-core.js
//
// Pure core shared by the session memory distiller (condenseTranscript, now
// feeding the Mem0 admission loop) and the curated memory writer
// (renderMemoryFile/renderIndexLine/slugify, used by memory-writer.js). No
// I/O, no network, no imports from other project modules.
//
// D23/D24 cutover (glmps-159 task 6): buildDistillPrompt, parseDistillResponse
// and classifyFact - the pre-D23 LLM-extraction prompt, its tolerant JSON
// parser, and the confidence/dedup gate that routed a Fact to the L3
// distilled pool or a human-review proposal - are retired along with that
// pipeline. Mem0's own `add({ infer: true })` does extraction and dedup
// internally now (server/lib/plugins/memory-plugin.js).


export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Reduces a raw JSONL transcript (one Claude Code session-log entry per
// line) down to just the human-relevant text: user turns and assistant
// text blocks. Tool calls/results are dropped as noise. The result is
// truncated to `maxBytes`, keeping the TAIL (most recent content matters
// most for a Stop-time distillation).

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text);
    return texts.length ? texts.join('\n') : '';
  }
  return '';
}

// Returns { role: 'USER'|'ASSISTANT', text } for a real turn, or null for
// anything else (tool-only turns, unknown line types). The role label is
// carried through to condenseTranscript's output (glmps-159, task 6): Mem0's
// conversational admission (memory-plugin.js's condensedToMessages) needs to
// tell user turns from assistant turns to build a real messages[] array, and
// this is the only place that still has obj.type once the line is condensed.
function extractLineText(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type === 'user' || obj.type === 'assistant') {
    const content = obj.message && typeof obj.message === 'object' ? obj.message.content : undefined;
    const text = textFromContent(content);
    return text ? { role: obj.type === 'user' ? 'USER' : 'ASSISTANT', text } : null;
  }
  return null;
}

export function condenseTranscript(lines, { maxBytes = 60000 } = {}) {
  const parts = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // skip malformed lines, never throw
    }
    let entry;
    try {
      entry = extractLineText(obj);
    } catch {
      continue;
    }
    if (entry) parts.push(`${entry.role}: ${entry.text}`);
  }
  let out = parts.join('\n');
  if (Buffer.byteLength(out) > maxBytes) {
    out = out.slice(out.length - maxBytes);
  }
  return out;
}


export function renderMemoryFile(fact, { sessionId } = {}) {
  const links = (fact.wikilinks || []).map((l) => `[[${l}]]`).join(' ');
  return (
    `---\nname: ${slugify(fact.name)}\ndescription: ${fact.description}\nmetadata:\n  node_type: memory\n  type: ${fact.type}\n`
    + (sessionId ? `  originSessionId: ${sessionId}\n` : '')
    + `---\n\n${fact.body}\n${links ? `\n${links}\n` : ''}`
  );
}

// Index-line budget.
//
// MEMORY.md is inlined into EVERY session's context, so its size is a cost
// paid on every turn of every session, while the detail an over-long index
// line carries is already stored in full in the body file (renderMemoryFile
// keeps the untruncated description in frontmatter). An index line is
// therefore a POINTER, not a summary, and capping it loses nothing
// corpus-wide: it moves detail back to where it already lives.
//
// The cap applies to the whole rendered line, but MIN_DESC is a hard floor
// on the description's share and it wins. That ordering is load-bearing:
// the `- [Title](slug.md) - ` prefix is STRUCTURAL, and for a descriptive
// title it can run to 87 chars. Charging that against the description
// budget would leave the best-labeled entries with the least room for their
// punchline, which is backwards. A line may therefore exceed
// INDEX_LINE_MAX; a hook too short to carry the verdict is the worse
// failure.
//
// SEPARATOR is a spaced hyphen, not an em-dash: index lines are content the
// user reads, and the global no-em-dash policy applies to generated text.

export const INDEX_LINE_MAX = 120;
export const SEPARATOR = ' - ';
export const MIN_DESC = 70;
export const MIN_BOUNDARY = 40;

// Cut `desc` to fit `budget`, preferring a clause boundary. A boundary cut
// reads as a complete thought so it is left unmarked; a mid-clause cut is
// marked "..." so a truncated hook is never mistaken for the whole fact.
//
// MIN_BOUNDARY is deliberately separate from MIN_DESC: a boundary cut only
// needs to leave enough to be meaningful (so a terse "DECLINED." cannot
// swallow the line), whereas MIN_DESC governs how much room the entry gets
// in the first place. Tying them together would disable boundary cuts
// entirely, since no boundary can sit past the end of its own budget.
export function capDescription(desc, budget) {
  const text = String(desc ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= budget) return text;

  const window = text.slice(0, budget);
  const boundary = Math.max(window.lastIndexOf('. '), window.lastIndexOf('; '));
  if (boundary >= MIN_BOUNDARY) return window.slice(0, boundary).trim();

  const room = budget - 3; // leave space for the "..." marker
  const space = window.lastIndexOf(' ', room);
  const cut = space > 0 ? space : room;
  return `${window.slice(0, cut).replace(/[\s,;:.]+$/, '')}...`;
}

export function renderIndexLine(fact) {
  const slug = slugify(fact.name);
  const prefix = `- [${slug}](${slug}.md)${SEPARATOR}`;
  const budget = Math.max(MIN_DESC, INDEX_LINE_MAX - prefix.length);
  return prefix + capDescription(fact.description, budget);
}
