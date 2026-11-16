// server/lib/adapters/index.js
import os from 'node:os';
import path from 'node:path';
import { isDirectory } from './fs-util.js';
import { isTestProcess, noRealAdapterDataDir } from '../paths.js';
import * as claudeCode from './claude-code.js';
import * as antigravity from './antigravity.js';
import * as geminiCli from './gemini-cli.js';
import * as copilotChat from './copilot-chat.js';
import * as copilotCli from './copilot-cli.js';
import * as codexCli from './codex-cli.js';
import * as hermes from './hermes.js';
import * as agyCli from './agy-cli.js';
import * as cline from './cline.js';
import * as opencode from './opencode.js';
import * as openclaw from './openclaw.js';
import * as cursorCli from './cursor-cli.js';
import * as grok from './grok.js';
import * as pi from './pi.js';
import * as droid from './droid.js';

export const adapters = [claudeCode, antigravity, geminiCli, copilotChat, copilotCli, codexCli, hermes, agyCli, cline, opencode, openclaw, cursorCli, grok, pi, droid];

const HOME = os.homedir();
const appData = process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming');
const localAppData = process.env.LOCALAPPDATA ?? path.join(HOME, 'AppData', 'Local');
// Phase K final review (minors wave): these five entries derived their
// dataDirs from os.homedir() directly at import time, bypassing getPaths()'s
// own test-process redirect entirely - a test process with no override
// scanned the operator's real editor/CLI install dirs below. Computed once,
// like the rest of this module-level table; isTestProcess() is a stable,
// process-wide signal, so this never needs to be recomputed per call.
const DETECT_ONLY_TEST_PROCESS = isTestProcess();

/**
 * Detect-only tools - no discover/extract, just presence detection.
 * Each entry: { id, displayName, dataDirs: string[] }
 */
const DETECT_ONLY = [
  {
    id: 'cursor',
    displayName: 'Cursor',
    dataDirs: DETECT_ONLY_TEST_PROCESS ? [noRealAdapterDataDir('cursor')] : [path.join(appData, 'Cursor'), path.join(HOME, '.cursor')],
  },
  {
    id: 'windsurf',
    displayName: 'Windsurf',
    dataDirs: DETECT_ONLY_TEST_PROCESS ? [noRealAdapterDataDir('windsurf')] : [path.join(appData, 'Windsurf'), path.join(HOME, '.windsurf')],
  },
  {
    id: 'aider',
    displayName: 'Aider',
    dataDirs: DETECT_ONLY_TEST_PROCESS ? [noRealAdapterDataDir('aider')] : [path.join(HOME, '.aider')],
  },
  {
    id: 'continue',
    displayName: 'Continue',
    dataDirs: DETECT_ONLY_TEST_PROCESS ? [noRealAdapterDataDir('continue')] : [path.join(HOME, '.continue')],
  },
  {
    id: 'zed',
    displayName: 'Zed',
    dataDirs: DETECT_ONLY_TEST_PROCESS ? [noRealAdapterDataDir('zed')] : [path.join(appData, 'Zed'), path.join(localAppData, 'Zed')],
  },
];

/**
 * Returns true iff the adapter with the given toolId has controllable===true.
 * @param {string} toolId
 * @returns {boolean}
 */
export function isControllable(toolId) {
  return adapters.find(a => a.id === toolId)?.controllable === true;
}

/**
 * Returns true iff at least one installed adapter is also controllable.
 * @param {object} P - getPaths() result
 * @returns {boolean}
 */
export function anyControllable(P) {
  return adapters.some(a => {
    if (a.controllable !== true) return false;
    try { return a.detect(P).installed === true; } catch { return false; }
  });
}

/**
 * Run detect() on every adapter and return a summary array.
 * Also includes detect-only entries (depth:'detect-only').
 * @param {object} P - getPaths() result
 * @returns {{ id, displayName, installed, dataDirs, depth }[]}
 */
export function detectAll(P) {
  const deep = adapters.map(a => {
    const { installed, dataDirs } = a.detect(P);
    return { id: a.id, displayName: a.displayName, installed, dataDirs, depth: 'deep' };
  });

  const detectOnly = DETECT_ONLY.map(entry => {
    const installed = entry.dataDirs.some(isDirectory);
    return { id: entry.id, displayName: entry.displayName, installed, dataDirs: entry.dataDirs, depth: 'detect-only' };
  });

  return [...deep, ...detectOnly];
}
