// apps/shell/src/lib/setup/actions.js
// What the setup wizard can run, and nothing else. Three ways to start a
// process, each closed: a visible console window for the installs and sign-ins
// (argv built only from the constants below), a kernel script from a fixed
// allowlist run with the bundled node, and `reg query` to refresh PATH.
// Secrets travel to a child by environment variable only: nothing here logs,
// echoes or returns one. No electron import.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { windowsCmdPath } from '../terminal-recipe.js';

const winget = (verb, id) => ['winget', verb, '--id', id, '--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements'];
const wingetDep = (id) => ({ install: winget('install', id), update: winget('upgrade', id) });

// A parity-tested copy of the install/update argv in server/lib/chassis/deps.js
// (DEP_MANIFEST): the packaged shell cannot import server code.
export const DEP_COMMANDS = Object.freeze({
  node: wingetDep('OpenJS.NodeJS.LTS'),
  git: wingetDep('Git.Git'),
  graphify: { install: ['uv', 'tool', 'install', 'graphifyy'], update: ['uv', 'tool', 'install', 'graphifyy@latest'] },
  claude: wingetDep('Anthropic.ClaudeCode'),
  gh: wingetDep('GitHub.cli'),
});

export const GH_SCOPES = Object.freeze(['repo', 'workflow', 'read:org']);
export const CLAUDE_LOGIN = Object.freeze(['claude', 'auth', 'login']);
export const GH_LOGIN = Object.freeze(['gh', 'auth', 'login', '--web', '--git-protocol', 'https', '--scopes', GH_SCOPES.join(',')]);
export const GH_SETUP_GIT = Object.freeze(['gh', 'auth', 'setup-git']);
// graphify installs through uv, which a fresh PC does not have.
export const UV_INSTALL = Object.freeze(winget('install', 'astral-sh.uv'));

export function depArgv(name, verb) {
  const cmd = Object.hasOwn(DEP_COMMANDS, name) ? DEP_COMMANDS[name][verb] : null;
  return cmd ? [...cmd] : null;
}

export function ghRefreshArgv(scopes) {
  const wanted = GH_SCOPES.filter((s) => Array.isArray(scopes) && scopes.includes(s));
  return wanted.length ? ['gh', 'auth', 'refresh', '--scopes', wanted.join(',')] : null;
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export function isAllowedVisibleArgv(argv) {
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string')) return false;
  const fixed = [CLAUDE_LOGIN, GH_LOGIN, GH_SETUP_GIT, UV_INSTALL, ...Object.values(DEP_COMMANDS).flatMap((d) => [d.install, d.update])];
  if (fixed.some((f) => same(f, argv))) return true;
  if (argv.length === 5 && same(argv.slice(0, 4), ['gh', 'auth', 'refresh', '--scopes'])) {
    const given = argv[4].split(',');
    return given.length > 0 && given.every((s) => GH_SCOPES.includes(s));
  }
  return false;
}

function resolveOnPath(name, { env, exists }) {
  const exts = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of String(env.PATH || env.Path || '').split(';').filter(Boolean)) {
    for (const ext of exts) {
      const hit = path.win32.join(dir, name + ext.toLowerCase());
      if (exists(hit)) return hit;
    }
  }
  return null;
}

const plain = /^[A-Za-z0-9_.:/\\=@+-]+$/;
const quote = (a) => (plain.test(a) ? a : `"${a}"`);

// `cmd /c start "" /wait <program> <args>`: start gives the program its own
// visible console and /wait makes cmd exit with the program's exit code. The
// command line is one verbatim string because Node's own quoting would leave
// the comma in the gh scopes for cmd to split. An npm .cmd shim goes through
// cmd.exe by absolute path, as probeArgv does in the kernel.
export function visibleSpawn(argv, { env = process.env, exists = fs.existsSync } = {}) {
  const cmdExe = windowsCmdPath(env);
  const [name, ...rest] = argv;
  const hit = resolveOnPath(name, { env, exists });
  const tail = rest.map(quote).join(' ');
  let program;
  if (hit && /\.(cmd|bat)$/i.test(hit)) program = `"${cmdExe}" /d /s /c ""${hit}" ${tail}"`;
  else program = `${hit ? `"${hit}"` : name}${tail ? ` ${tail}` : ''}`;
  return {
    file: cmdExe,
    args: [`/d /c start "" /wait ${program}`],
    options: { windowsVerbatimArguments: true, windowsHide: false, stdio: 'ignore', shell: false, env: { ...env, NoDefaultCurrentDirectoryInExePath: '1' } },
  };
}

export function runVisible(argv, { spawnImpl = spawn, platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (!isAllowedVisibleArgv(argv)) return Promise.resolve({ code: null, error: 'command-not-allowed' });
  if (platform !== 'win32') return Promise.resolve({ code: null, error: 'unsupported-platform' });
  const r = visibleSpawn(argv, { env, exists });
  return new Promise((resolve) => {
    let child;
    try { child = spawnImpl(r.file, r.args, r.options); } catch (e) { resolve({ code: null, error: e.message }); return; }
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    child.on('error', (e) => finish({ code: null, error: e.message }));
    child.on('exit', (code) => finish({ code: code ?? null }));
  });
}

const JSON_SCRIPTS = new Set(['scripts/setup/setup-status.mjs', 'scripts/setup/slack-connect.mjs', 'scripts/setup/editor-setup.mjs']);
// A parity-tested copy of TARGET_IDS/TARGET_LABELS in
// server/lib/orchestration/editor-targets.js. The only values the Default IDE
// step ever passes to a script; the script validates them again.
export const EDITOR_TARGETS = Object.freeze({
  'vscode': 'VS Code', 'vscode-insiders': 'VS Code Insiders', 'cursor': 'Cursor',
  'windsurf': 'Windsurf', 'antigravity': 'Antigravity', 'native-terminal': 'Native terminal',
});

const INSTALL_REASON = {
  'not-installed': (label) => `${label} is not installed.`,
  'no-package': () => 'This GLMPS install has no extension package to install. Rebuild the app with the companion package, or install the extension by hand.',
  'unsafe-path': () => 'The IDE or extension package is in a folder the wizard will not run a command from.',
  'bad-target': () => 'That IDE is not one GLMPS supports.',
};

export const KERNEL_SCRIPTS = Object.freeze([...JSON_SCRIPTS, 'scripts/install.mjs', 'scripts/glmps-init.mjs']);
const MAX_OUTPUT = 1_000_000;

function lastJsonObject(text) {
  for (const line of text.split(/\r?\n/).reverse()) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { const v = JSON.parse(t); if (v && typeof v === 'object') return v; } catch { /* not the JSON line */ }
  }
  return null;
}

// JSON scripts return { code, json }; the text scripts return { code, tail }.
// A script that was handed secrets is a JSON script, so no output of it is
// ever returned as text.
export function runKernelScript({ node, kernelDir, script, args = [], env = {}, cwd, baseEnv = process.env, spawnImpl = spawn, timeoutMs = 300_000 }) {
  if (!KERNEL_SCRIPTS.includes(script)) return Promise.resolve({ code: null, error: 'script-not-allowed' });
  if (!node || !kernelDir || !Array.isArray(args) || !args.every((a) => typeof a === 'string' && !a.includes('\0'))) return Promise.resolve({ code: null, error: 'bad-arguments' });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(node, [path.join(kernelDir, ...script.split('/')), ...args], {
        cwd: cwd ?? kernelDir, env: { ...baseEnv, ...env }, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) { resolve({ code: null, error: e.message }); return; }
    let out = '';
    let err = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish({ code: null, error: 'timeout' }); }, timeoutMs);
    child.stdout?.on('data', (d) => { if (out.length < MAX_OUTPUT) out += d; });
    child.stderr?.on('data', (d) => { if (err.length < MAX_OUTPUT) err += d; });
    child.on('error', (e) => finish({ code: null, error: e.message }));
    child.on('close', (code) => {
      if (JSON_SCRIPTS.has(script)) finish({ code, json: lastJsonObject(out) });
      else finish({ code, tail: `${out}\n${err}`.trim().slice(-1500) });
    });
  });
}

function expandVars(text, env) {
  return text.replace(/%([^%]+)%/g, (whole, name) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? env[key] : whole;
  });
}

function regPath(stdout) {
  const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/im.exec(String(stdout ?? ''));
  return m ? m[1] : '';
}

export function mergePathEntries({ current = '', user = '', machine = '', env = process.env }) {
  const seen = new Set();
  const out = [];
  for (const raw of [current, expandVars(user, env), expandVars(machine, env)].flatMap((p) => p.split(';'))) {
    const entry = raw.trim();
    const key = entry.replace(/[\\/]+$/, '').toLowerCase();
    if (!entry || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.join(';');
}

const defaultReg = (argv) => {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', windowsHide: true, shell: false });
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
};

const HKCU = 'HKCU\\Environment';
const HKLM = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';

// After a winget install the running app still holds the PATH it started with;
// the new tool is only in the registry. Fail open: an unreadable key adds nothing.
export async function refreshPathFromRegistry({ run = defaultReg, env = process.env } = {}) {
  const read = async (key) => { try { const r = await run(['reg', 'query', key, '/v', 'Path']); return r?.status === 0 ? regPath(r.stdout) : ''; } catch { return ''; } };
  const current = env.Path ?? env.PATH ?? '';
  return mergePathEntries({ current, user: await read(HKCU), machine: await read(HKLM), env });
}

const ERROR_TEXT = {
  invalid_auth: 'Slack rejected the bot token (invalid_auth). Copy the Bot User OAuth Token from Install App.',
  not_authed: 'Slack rejected the bot token (not_authed). Copy the Bot User OAuth Token from Install App.',
  token_revoked: 'That bot token was revoked. Install the app again and copy the new token.',
  missing_scope: 'The Slack app is missing a permission. Create it again from the button above, or add the scope and reinstall.',
  invalid_tokens: 'The tokens do not look right: the bot token starts with xoxb- and the app token with xapp-.',
  unreachable: 'Slack could not be reached, so the tokens were not checked or saved. Check the internet connection and try again.',
  'app_token:invalid_auth': 'Slack rejected the app-level token (invalid_auth). Generate one under Basic Information, App-Level Tokens, with connections:write.',
  'app_token:not_allowed_token_type': 'That is not an app-level token. Generate one under Basic Information, App-Level Tokens, with connections:write.',
  'app_token:missing_scope': 'The app-level token lacks connections:write. Generate a new one with that scope under Basic Information, App-Level Tokens.',
  'app_token:token_revoked': 'That app-level token was revoked. Generate a new one with connections:write under Basic Information, App-Level Tokens.',
};

const clean = (v, max = 400) => (typeof v === 'string' && v.trim().length <= max ? v.trim() : '');

export function slackMessage(json) {
  if (!json) return 'The Slack step did not answer.';
  if (!json.ok) return ERROR_TEXT[json.error] ?? `Slack could not be connected (${String(json.error ?? 'unknown')}).`;
  const channels = (json.channels?.created?.length ?? 0) + (json.channels?.existing?.length ?? 0);
  const who = json.userId ? ` You were added to ${json.joined?.length ?? 0} of them.` : '';
  const notes = json.warnings?.length ? ` Notes: ${json.warnings.join('; ')}.` : '';
  return `Connected to ${json.team ?? 'your workspace'} as ${json.botUser ?? 'the bot'}. ${channels} channels are ready.${who}${notes}`;
}

const exitMessage = (what, r) => (r.error ? `${what} could not start (${r.error}).` : r.code === 0 ? `${what} finished.` : `${what} did not finish (exit ${r.code}).`);

// The step+action to function map the wizard window dispatches. Each returns
// { ok, message }. ctx supplies every effect: visible, kernelScript, refreshPath,
// kernel ({ node, kernelDir } or null), userData, stateDirOverride,
// kernelStateDir (where the kernel keeps its state, so the profile can be put
// where a kernel the app did not launch looks for it), getStatus,
// restartKernel, log, fsImpl.
export function createSetupHandlers(ctx) {
  const { visible = runVisible, kernelScript = runKernelScript, refreshPath = async () => {}, kernel, userData, stateDirOverride = null, kernelStateDir = null,
    getStatus = () => ({}), restartKernel = async () => ({ ok: false, message: 'not available' }), log = () => {}, fsImpl = fs } = ctx;
  const noKernel = { ok: false, message: 'This install has no local GLMPS kernel to run that. Use the tray menu on the machine that runs it.' };
  // Every script resolves the state dir the same way, or one writes where another does not read.
  const stateEnv = stateDirOverride ? { GLMPS_STATE_DIR: stateDirOverride } : {};
  const script = (name, { env, ...opts } = {}) => kernelScript({ node: kernel.node, kernelDir: kernel.kernelDir, script: name, ...opts, env: { ...env, ...stateEnv } });

  async function installAll(verb, names) {
    const failed = [];
    for (const name of names) {
      const argv = depArgv(name, verb);
      if (!argv) continue;
      log('info', 'setup: dependency command', { name, verb });
      if (name === 'graphify' && verb === 'install') {
        // winget exits non-zero when uv is already installed; the graphify run below is the real check.
        await visible([...UV_INSTALL]);
        await refreshPath();
      }
      const r = await visible(argv);
      await refreshPath();
      if (r.code !== 0) failed.push(`${name} (${r.error ?? `exit ${r.code}`})`);
    }
    return failed;
  }
  const depRows = (action) => (getStatus().deps ?? []).filter((d) => d.action === action).map((d) => d.name);
  const depResult = (verb, names, failed) => (failed.length
    ? { ok: false, message: `Could not ${verb} ${failed.join(', ')}. Check the console output, then try again.` }
    : { ok: true, message: names.length ? `${verb === 'install' ? 'Installed' : 'Updated'} ${names.join(', ')}.` : 'Nothing to do.' });

  const noPick = { ok: false, message: 'Choose an IDE first.' };
  async function installCompanionInto(id) {
    const r = await script('scripts/setup/editor-setup.mjs', { args: ['install', id] });
    log('info', 'setup: companion install finished', { id, code: r.code, ok: r.json?.ok ?? false });
    if (r.json?.ok) return { ok: true, message: `The GLMPS extension is installed in ${EDITOR_TARGETS[id]}. Restart ${EDITOR_TARGETS[id]} once so it loads.` };
    const reason = String(r.json?.reason ?? r.error ?? 'no answer');
    const text = (INSTALL_REASON[reason] ?? (() => `The extension install did not finish (${reason.slice(0, 200)}).`))(EDITOR_TARGETS[id]);
    return { ok: false, message: text };
  }
  async function chooseEditor(id) {
    if (!kernel) return noKernel;
    const saved = await script('scripts/setup/editor-setup.mjs', { args: ['save', id] });
    if (!saved.json?.ok) return { ok: false, message: `The choice was not saved (${String(saved.json?.reason ?? saved.error ?? 'no answer').slice(0, 200)}).` };
    log('info', 'setup: default editor saved', { id });
    if (id === 'native-terminal') return { ok: true, message: 'Sessions and Open in editor will use a native terminal.' };
    const row = (getStatus().editors ?? []).find((e) => e.id === id);
    if (row?.companion) return { ok: true, message: `Sessions and Open in editor now use ${EDITOR_TARGETS[id]}.` };
    const r = await installCompanionInto(id);
    return r.ok
      ? { ok: true, message: `Sessions and Open in editor now use ${EDITOR_TARGETS[id]}. ${r.message}` }
      : { ok: false, message: `Your choice of ${EDITOR_TARGETS[id]} is saved, but ${r.message.charAt(0).toLowerCase()}${r.message.slice(1)}` };
  }

  const handlers = {
    'editor:install-companion': async () => {
      if (!kernel) return noKernel;
      const id = getStatus().editorPick?.lastTarget;
      if (!Object.hasOwn(EDITOR_TARGETS, id ?? '') || id === 'native-terminal') return noPick;
      return installCompanionInto(id);
    },
    'deps:install-missing': async () => { const n = depRows('install'); return depResult('install', n, await installAll('install', n)); },
    'deps:update-all': async () => { const n = depRows('update-available'); return depResult('update', n, await installAll('update', n)); },
    'claude:sign-in': async () => {
      const r = await visible([...CLAUDE_LOGIN]);
      await refreshPath();
      return { ok: r.code === 0, message: exitMessage('Claude sign-in', r) };
    },
    'github:sign-in': async () => {
      const r = await visible([...GH_LOGIN]);
      await refreshPath();
      if (r.code !== 0) return { ok: false, message: exitMessage('GitHub sign-in', r) };
      const g = await visible([...GH_SETUP_GIT]);
      return { ok: g.code === 0, message: g.code === 0 ? 'GitHub is signed in and git is set to use it.' : exitMessage('Connecting git to GitHub', g) };
    },
    'github:refresh-scopes': async () => {
      const argv = ghRefreshArgv(getStatus().github?.missingScopes);
      if (!argv) return { ok: true, message: 'No permissions are missing.' };
      const r = await visible(argv);
      return { ok: r.code === 0, message: exitMessage('Granting GitHub permissions', r) };
    },
    'slack:connect': async (input = {}) => {
      if (!kernel) return noKernel;
      const botToken = clean(input.botToken);
      const appToken = clean(input.appToken);
      if (!botToken.startsWith('xoxb-') || !appToken.startsWith('xapp-') || /\s/.test(botToken + appToken)) return { ok: false, message: ERROR_TEXT.invalid_tokens };
      const r = await script('scripts/setup/slack-connect.mjs', {
        env: {
          SETUP_BOT_TOKEN: botToken, SETUP_APP_TOKEN: appToken,
          SETUP_SLACK_EMAIL: clean(input.email, 320), SETUP_SLACK_MEMBER_ID: clean(input.memberId, 40),
        },
      });
      log('info', 'setup: slack connect finished', { code: r.code, ok: r.json?.ok ?? false, error: r.json?.error ?? r.error ?? null });
      const message = slackMessage(r.json);
      if (!r.json?.ok) return { ok: false, message };
      const restarted = await restartKernel();
      return { ok: true, message: `${message} ${restarted.ok ? 'GLMPS restarted so Slack starts.' : `GLMPS could not restart itself (${restarted.message}); restart it from the tray menu.`}` };
    },
    'ide:install-hooks': async () => {
      if (!kernel) return noKernel;
      const r = await script('scripts/install.mjs', {});
      log('info', 'setup: hooks install finished', { code: r.code });
      return { ok: r.code === 0, message: r.code === 0 ? 'The GLMPS hooks and status line are installed in Claude Code.' : `The install did not finish. ${(r.tail ?? r.error ?? '').split('\n').slice(-3).join(' ')}`.trim() };
    },
    'repos:scan': async (input = {}) => {
      if (!kernel) return noKernel;
      const folder = clean(input.folder, 1000);
      const engagement = clean(input.engagement, 80);
      if (!engagement || /[\x00-\x1f]/.test(engagement) || engagement.startsWith('-')) return { ok: false, message: 'Give the engagement a name (letters, numbers and spaces).' };
      let isDir = false;
      try { isDir = path.isAbsolute(folder) && fsImpl.statSync(folder).isDirectory(); } catch { isDir = false; }
      if (!isDir) return { ok: false, message: 'Choose a folder that exists.' };
      fsImpl.mkdirSync(userData, { recursive: true });
      const r = await script('scripts/glmps-init.mjs', { args: ['--engagement', engagement, '--search', folder, '--force'], cwd: userData });
      log('info', 'setup: repo scan finished', { code: r.code });
      if (r.code !== 0) return { ok: false, message: `The scan did not finish. ${(r.tail ?? r.error ?? '').split('\n').slice(-3).join(' ')}`.trim() };
      // The app's own kernel is pointed at the userData copy at launch; a
      // kernel it did not launch (the service, a checkout) reads the state
      // dir's copy. Either one reads its profile only at boot.
      if (kernelStateDir) {
        try {
          fsImpl.mkdirSync(kernelStateDir, { recursive: true });
          fsImpl.copyFileSync(path.join(userData, 'glmps.profile.json'), path.join(kernelStateDir, 'glmps.profile.json'));
        } catch (e) {
          log('warn', 'setup: profile copy to the state dir failed', { error: e?.message });
          return { ok: false, message: `GLMPS wrote a profile but could not put it where the running GLMPS reads it (${e?.message ?? e}).` };
        }
      }
      const restarted = await restartKernel();
      return { ok: true, message: `GLMPS found your repositories and wrote a profile. ${restarted.ok ? 'GLMPS restarted to use it.' : `GLMPS could not restart itself (${restarted.message}); restart it from the tray menu so it uses the profile.`}` };
    },
  };
  for (const id of Object.keys(EDITOR_TARGETS)) handlers[`editor:choose-${id}`] = () => chooseEditor(id);
  for (const name of Object.keys(DEP_COMMANDS)) {
    handlers[`deps:install-${name}`] = async () => depResult('install', [name], await installAll('install', [name]));
    handlers[`deps:update-${name}`] = async () => depResult('update', [name], await installAll('update', [name]));
  }
  return handlers;
}
