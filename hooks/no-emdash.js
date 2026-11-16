#!/usr/bin/env node
// PreToolUse (Write|Edit|MultiEdit) and Stop hook: the house no-em-dash rule.
// A write whose new content holds an em-dash (U+2014) or horizontal bar
// (U+2015) is denied with a reason so the model rewrites it. On Stop, the
// last assistant message is scanned and a hit blocks the stop so the message
// is re-sent without it (a hook cannot un-send text, so this is reactive).
// The en-dash (U+2013) is allowed so numeric ranges still work.
//
// Escape hatch: CLAUDE_ALLOW_EMDASH=1 disables both checks. Every failure
// (bad stdin, unreadable transcript) allows.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Built from char codes so this file stays ASCII (ascii-source.test.js).
const BAD = new RegExp(`[${String.fromCharCode(0x2014, 0x2015)}]`);
const FIX_HINT = 'Replace every em-dash with a comma, colon, parenthesis, or " - " (spaced hyphen).';
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

function newContent(ti = {}) {
  const parts = [];
  if (typeof ti.content === 'string') parts.push(ti.content);
  if (typeof ti.new_string === 'string') parts.push(ti.new_string);
  if (Array.isArray(ti.edits)) {
    for (const e of ti.edits) if (e && typeof e.new_string === 'string') parts.push(e.new_string);
  }
  return parts.join('\n');
}

function lastAssistantText(raw) {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    const content = rec?.type === 'assistant' ? rec.message?.content : null;
    if (Array.isArray(content)) {
      return content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
    }
  }
  return '';
}

export function checkEmdash(input, { env = process.env, readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  if (env.CLAUDE_ALLOW_EMDASH === '1') return {};
  if (WRITE_TOOLS.has(input?.tool_name)) {
    if (!BAD.test(newContent(input.tool_input))) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `This write contains an em-dash, which the no-em-dash policy forbids. ${FIX_HINT} Then retry the write.`,
      },
    };
  }
  if (input?.hook_event_name === 'Stop' || input?.transcript_path) {
    // stop_hook_active: this Stop is the re-send we forced; never block twice.
    if (input.stop_hook_active) return {};
    let text;
    try { text = lastAssistantText(readFile(input.transcript_path)); } catch { return {}; }
    if (!BAD.test(text)) return {};
    return {
      decision: 'block',
      reason: `Your last response contained an em-dash, which the no-em-dash policy forbids. Re-send that message verbatim except: ${FIX_HINT}`,
    };
  }
  return {};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let raw = '';
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    let out = {};
    try { out = checkEmdash(JSON.parse(raw || '{}')); } catch { /* fail open */ }
    process.stdout.write(JSON.stringify(out));
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
  setTimeout(finish, 2000).unref();
}
