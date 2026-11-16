import * as vscode from 'vscode';
import { TERMINAL_ICON_ID, terminalTabTitle } from './terminal-icon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { withShellExit } from './shell-exit';
import { terminalName } from './terminal-name';
import { watchRequests } from './request-watch';
import { hostTarget, requestsFileName } from './host-target';

const requestsDir = path.join(os.homedir(), '.glmps', 'requests');
// Set at activation from the host IDE; an unknown host drains nothing.
let requestsFile = '';

type ServerState = 'up' | 'starting' | 'down' | 'no-path';

function cfg<T>(key: string): T { return vscode.workspace.getConfiguration('missionControl').get(key) as T; }

function healthy(port: number): Promise<boolean> {
  return new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 },
      x => { x.resume(); res(x.statusCode === 200); });
    r.on('error', () => res(false));
    r.on('timeout', () => { r.destroy(); res(false); });
  });
}


let outputChannel: vscode.OutputChannel | undefined;
function note(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? `: ${err.message}` : err ? `: ${String(err)}` : '';
  try { (outputChannel ??= vscode.window.createOutputChannel('GLMPS')).appendLine(`${msg}${detail}`); } catch { console.error(`GLMPS ${msg}${detail}`); }
}

let statusItem: vscode.StatusBarItem | undefined;
let iconDataUri = '';            // data: URI of media/icon.png, built once at activation
let serverState: ServerState = 'down';

// Status-bar glyph + label + (optional) prominent background per state. The running state
// uses the contributed GLMPS mark (contributes.icons -> media/glmps-icons.woff); the other
// states use built-in codicons that read as status. The full-color PNG lives in the popup.
const STATE_META: Record<ServerState, { icon: string; label: string; bg?: string }> = {
  up:        { icon: 'glmps-mark',   label: 'Running' },
  starting:  { icon: 'loading~spin', label: 'Starting\u2026' },
  down:      { icon: 'warning',      label: 'Stopped',             bg: 'statusBarItem.warningBackground' },
  'no-path': { icon: 'warning',      label: 'Server path not set', bg: 'statusBarItem.errorBackground' },
};

function setState(s: ServerState): void {
  serverState = s;
  render();
}

function render(): void {
  if (!statusItem) return;
  const m = STATE_META[serverState];
  statusItem.text = `$(${m.icon}) GLMPS`;
  statusItem.backgroundColor = m.bg ? new vscode.ThemeColor(m.bg) : undefined;
  statusItem.tooltip = buildTooltip();
}

// Rich hover popup: brand icon + live status + contextual action links.
function buildTooltip(): vscode.MarkdownString {
  const port = cfg<number>('port');
  const m = STATE_META[serverState];
  const md = new vscode.MarkdownString(undefined, true); // supportThemeIcons
  md.isTrusted = true;
  md.supportHtml = true;
  if (iconDataUri) md.appendMarkdown(`<img src="${iconDataUri}" width="44" alt="GLMPS"/>\n\n`);

  const dot = serverState === 'up' ? '$(circle-filled)'
    : serverState === 'starting' ? '$(loading~spin)'
    : '$(error)';
  md.appendMarkdown(`**GLMPS** &nbsp; ${dot} ${m.label}\n\n`);

  if (serverState === 'up') {
    md.appendMarkdown(`Dashboard &nbsp; [http://127.0.0.1:${port}](http://127.0.0.1:${port})\n\n`);
    md.appendMarkdown(`[$(globe) Open dashboard](command:missionControl.open)`);
  } else if (serverState === 'no-path') {
    md.appendMarkdown(`Set the absolute path to \`server/server.js\` in your GLMPS checkout, then reload.\n\n`);
    md.appendMarkdown(`[$(gear) Set server path](command:workbench.action.openSettings?%22missionControl.serverPath%22)`);
  } else {
    md.appendMarkdown(`[$(debug-start) Start server](command:missionControl.open) &nbsp;\u00B7&nbsp; [$(gear) Settings](command:workbench.action.openSettings?%22missionControl%22)`);
  }
  return md;
}


async function ensureServer(opts?: { quiet?: boolean }): Promise<boolean> {
  const port = cfg<number>('port');
  if (await healthy(port)) { setState('up'); return true; }

  const serverPath = (cfg<string>('serverPath') || '').trim();
  if (!serverPath) {
    setState('no-path');
    if (!opts?.quiet) {
      const pick = await vscode.window.showWarningMessage(
        'GLMPS: set missionControl.serverPath to your server/server.js to start the dashboard.',
        'Open settings');
      if (pick === 'Open settings') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'missionControl.serverPath');
      }
    }
    return false;
  }

  setState('starting');
  try {
    // process.execPath is the Antigravity (Electron) binary. Without ELECTRON_RUN_AS_NODE it
    // would launch a second editor window instead of running server.js; the flag makes it
    // behave as a plain Node runtime, which is how the dashboard actually gets started.
    // detached + unref + ignored stdio: the dashboard must outlive this extension host (an
    // editor reload or close must not take the server down with it), and a held pipe or a
    // child still attached to the host would keep both alive.
    spawn(process.execPath, [serverPath], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }).unref();
  } catch (e) { note('could not spawn the server; falling through to the health re-check', e); }

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await healthy(port)) { setState('up'); return true; }
  }
  setState('down');
  // Quiet on watchdog ticks so a persistent failure doesn't warn on every interval.
  if (!opts?.quiet) {
    vscode.window.showWarningMessage(`GLMPS server did not start \u2014 check missionControl.serverPath (${serverPath}).`);
  }
  return false;
}

function drainRequests(): void {
  // Claim the whole file by renaming it, then read and delete the claimed copy. Reading and then
  // truncating (the old approach) loses any line a writer appends between the two steps; after a
  // rename that writer simply creates a fresh requests file, which the next drain picks up.
  const claimed = `${requestsFile}.${process.pid}.${Date.now()}.draining`;
  try { fs.renameSync(requestsFile, claimed); } catch (e: any) {
    if (e?.code !== 'ENOENT') note('could not claim the requests file; will retry on the next change', e);
    return;
  }
  let lines: string[] = [];
  try { lines = fs.readFileSync(claimed, 'utf-8').split('\n').filter(Boolean); } catch (e) {
    note(`could not read the claimed requests file ${claimed}; left in place`, e);
    return;
  }
  try { fs.unlinkSync(claimed); } catch (e) { note(`could not delete the claimed requests file ${claimed}`, e); }
  for (const line of lines) {
    let req: any; try { req = JSON.parse(line); } catch { continue; }
    if (!req) continue;

    // New-terminal launcher: run an explicit command (or none) in a fresh terminal.
    if (req.type === 'terminal' || (typeof req.command === 'string' && !req.sessionId)) {
      const cmd = typeof req.command === 'string' ? req.command : '';
      const cwd = typeof req.cwd === 'string' && req.cwd ? req.cwd : undefined;
      const opts: vscode.TerminalOptions = {
        name: terminalName(req),
        cwd,
      };
      if ((req.location ?? 'editor') === 'editor' && 'Editor' in vscode.TerminalLocation) {
        (opts as any).location = vscode.TerminalLocation.Editor;
      }
      opts.name = terminalTabTitle(opts.name);
      opts.iconPath = new vscode.ThemeIcon(TERMINAL_ICON_ID);
      const term = vscode.window.createTerminal(opts);
      term.show();
      if (cmd) term.sendText(withShellExit(cmd, vscode.env.shell));
      continue;
    }

    // Resume an existing session.
    if (typeof req.sessionId !== 'string' || req.location === 'workspace') continue;
    const sid = req.sessionId.replace(/[^a-zA-Z0-9-]/g, '');
    if (!sid) continue;
    const opts: vscode.TerminalOptions = {
      name: `claude resume ${sid.slice(0, 8)}`,
      cwd: typeof req.cwd === 'string' && req.cwd ? req.cwd : undefined,
    };
    if (req.location === 'editor' && 'Editor' in vscode.TerminalLocation) {
      (opts as any).location = vscode.TerminalLocation.Editor;
    }
    opts.name = terminalTabTitle(opts.name);
    opts.iconPath = new vscode.ThemeIcon(TERMINAL_ICON_ID);
    const term = vscode.window.createTerminal(opts);
    term.show();
    term.sendText(`claude --resume ${sid}`);
  }
}

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusItem.command = 'missionControl.open';
  try {
    const buf = fs.readFileSync(path.join(ctx.extensionPath, 'media', 'icon.png'));
    iconDataUri = `data:image/png;base64,${buf.toString('base64')}`;
  } catch { /* no icon asset; tooltip falls back to text + codicons */ }
  setState('down'); // corrected immediately by the health check / auto-start below
  statusItem.show();

  ctx.subscriptions.push(statusItem,
    vscode.commands.registerCommand('missionControl.open', async () => {
      const ok = await ensureServer();
      if (ok) vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${cfg<number>('port')}`));
    }));

  if (cfg<boolean>('autoStart')) {
    void ensureServer();
    // Watchdog: activation and the status-bar button are otherwise the ONLY triggers, so a
    // server that dies (sleep/restart/kill/crash) stays dead until Antigravity is relaunched.
    // Re-check every 30s and respawn if unhealthy. ensureServer() early-returns when the server
    // is up, so this is just a cheap /api/health probe in the steady state. Guard overlapping ticks.
    let checking = false;
    const watchdog = setInterval(() => {
      if (checking) return;
      checking = true;
      void ensureServer({ quiet: true }).finally(() => { checking = false; });
    }, 30_000);
    ctx.subscriptions.push({ dispose: () => clearInterval(watchdog) });
  } else {
    // No auto-start: still reflect whether a server is already running, without spawning one.
    void healthy(cfg<number>('port')).then(up => setState(up ? 'up' : 'down'));
  }

  const host = hostTarget({ uriScheme: vscode.env.uriScheme, appName: vscode.env.appName });
  if (!host) { note(`unknown host (${vscode.env.appName}); not draining any request file`); return; }
  requestsFile = path.join(requestsDir, requestsFileName(host));
  try { fs.mkdirSync(requestsDir, { recursive: true }); } catch { /* the poll still drains once a writer creates it */ }
  // Drains now (anything queued while the IDE was closed), on every change, and every 30 s.
  ctx.subscriptions.push(watchRequests({
    dir: requestsDir,
    drain: drainRequests,
    watch: (dir, cb) => fs.watch(dir, cb),
    setTimer: (fn, ms) => setInterval(fn, ms),
    clearTimer: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  }));
}

export function deactivate(): void {}
