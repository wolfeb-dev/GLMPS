// server/lib/adapters/openclaw.js
// SPECULATIVE: Format inferred from openclaw docs and deepwiki. Unverified
// against live data - treat as best-effort until confirmed against real sessions.
import fs from 'node:fs';
import path from 'node:path';
import { cleanTitle } from './clean-title.js';
import { reportMiss } from './health.js';
import { isDirectory, mtimeMsOf, readJsonFile } from './fs-util.js';

export const id = 'openclaw';
export const displayName = 'OpenClaw';
export const controllable = false;

// First existing root of P.openclawDirs (paths.js: ~/.openclaw then ~/.clawdbot,
// test-redirected). An absent P.openclawDirs scans nothing.
function findRoot(P) {
  const candidates = Array.isArray(P?.openclawDirs) ? P.openclawDirs : [];
  for (const c of candidates) {
    if (typeof c === 'string' && isDirectory(c)) return c;
  }
  return null;
}

export function detect(P) {
  const root = findRoot(P);
  const dataDirs = Array.isArray(P?.openclawDirs) ? P.openclawDirs.filter(d => typeof d === 'string') : [];
  return { installed: root !== null, dataDirs };
}

/**
 * Try to read a sessions store file (sessions.json / store.json) and extract
 * a label for a given session basename.  Tolerant of any shape surprise.
 */
function readSessionLabel(storeFile, basename) {
  const obj = readJsonFile(storeFile);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const entry = obj[basename];
  if (!entry || typeof entry !== 'object') return null;
  return entry.label ?? entry.title ?? null;
}

export function discover(P) {
  const out = [];
  const root = findRoot(P);
  if (!root) return out;

  // agents/<agentId>/sessions/*.jsonl
  const agentsDir = path.join(root, 'agents');
  let agentDirs = [];
  try { agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }); } catch {}

  for (const agent of agentDirs) {
    if (!agent.isDirectory()) continue;
    const agentId = agent.name;
    const sessionsDir = path.join(agentsDir, agentId, 'sessions');
    const storeFile = path.join(sessionsDir, 'sessions.json');
    let files = [];
    try { files = fs.readdirSync(sessionsDir, { withFileTypes: true }); } catch { continue; }

    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const filePath = path.join(sessionsDir, f.name);
      const mtimeMs = mtimeMsOf(filePath);
      if (mtimeMs == null) continue;

      const basename = f.name.replace(/\.jsonl$/, '');
      const label = readSessionLabel(storeFile, basename);
      out.push({
        id: `openclaw:${agentId}:${basename}`,
        tool: id,
        kind: 'jsonl-tail',
        file: filePath,
        cwd: null,
        label: label ?? null,
        mtimeMs,
      });
    }
  }

  // sessions/*.jsonl (flat layout at root)
  const rootSessionsDir = path.join(root, 'sessions');
  const rootStoreFile = path.join(rootSessionsDir, 'store.json');
  let rootFiles = [];
  try { rootFiles = fs.readdirSync(rootSessionsDir, { withFileTypes: true }); } catch {}

  for (const f of rootFiles) {
    if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
    const filePath = path.join(rootSessionsDir, f.name);
    const mtimeMs = mtimeMsOf(filePath);
    if (mtimeMs == null) continue;

    const basename = f.name.replace(/\.jsonl$/, '');
    const label = readSessionLabel(rootStoreFile, basename);
    out.push({
      id: `openclaw:main:${basename}`,
      tool: id,
      kind: 'jsonl-tail',
      file: filePath,
      cwd: null,
      label: label ?? null,
      mtimeMs,
    });
  }

  return out;
}

/** jsonl-tail: one line -> events[] */
export function extractLine(line, sessionId) {
  let obj;
  try { obj = JSON.parse(line); } catch { return []; }
  if (!obj || typeof obj !== 'object') return [];

  const ts = obj.timestamp ?? obj.ts ?? null;

  // User message
  const isUser = obj.role === 'user'
    || obj.type === 'user'
    || (obj.type === 'message' && obj.role === 'user');
  if (isUser) {
    if (obj.content === undefined && obj.text === undefined) {
      reportMiss(id, 'user record has no content/text field');
      return [];
    }
    const content = obj.content ?? obj.text ?? '';
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.map(c => (typeof c === 'string' ? c : (c?.text ?? ''))).join('') : '';
    if (!text) return [];
    return [{
      kind: 'tool', lane: 'feed', tool: 'user', path: null, ts, sessionId,
      label: 'User: ' + (cleanTitle(text, 120) ?? text.slice(0, 120)),
    }];
  }

  // Tool calls - various field shapes seen across versions
  const isToolCall = obj.type === 'toolCall'
    || obj.tool_use != null
    || obj.type === 'tool_result';
  if (isToolCall) {
    const name = obj.name ?? obj.tool_use?.name ?? obj.tool ?? 'tool';
    return [{ kind: 'tool', lane: 'feed', tool: name, path: null, ts, sessionId, label: name }];
  }

  return [];
}
