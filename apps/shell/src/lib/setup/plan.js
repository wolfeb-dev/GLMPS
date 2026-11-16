// apps/shell/src/lib/setup/plan.js
// Pure: turns the kernel's health report (scripts/setup/setup-status.mjs), the
// saved progress and the busy flag into the State the wizard window renders.
// No electron, no fs beyond the injected one.
import fs from 'node:fs';
import path from 'node:path';

export const STEP_ORDER = Object.freeze(['welcome', 'deps', 'claude', 'github', 'slack', 'ide', 'editor', 'repos', 'health']);
export const PROGRESS_FILE = 'setup-progress.json';

const DEP_LABELS = Object.freeze({ node: 'Node.js', git: 'Git', graphify: 'graphify', claude: 'Claude Code', gh: 'GitHub CLI' });
const SKIPPABLE = new Set(['deps', 'claude', 'github', 'slack', 'ide', 'editor', 'repos']);

export const progressFile = (userDataDir) => path.join(userDataDir, PROGRESS_FILE);

export function normalizeProgress(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const ids = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => STEP_ORDER.includes(x)))] : []);
  const completed = ids(r.completed);
  return { completed, skipped: ids(r.skipped).filter((id) => !completed.includes(id)) };
}

export function markCompleted(progress, id) {
  const p = normalizeProgress(progress);
  return normalizeProgress({ completed: [...p.completed, id], skipped: p.skipped.filter((s) => s !== id) });
}

export function markSkipped(progress, id) {
  const p = normalizeProgress(progress);
  return normalizeProgress({ completed: p.completed.filter((c) => c !== id), skipped: [...p.skipped, id] });
}

// Fail open: a missing or unreadable record is a fresh start.
export function readProgress({ file, fsImpl = fs }) {
  try { return normalizeProgress(JSON.parse(fsImpl.readFileSync(file, 'utf8'))); } catch { return normalizeProgress(null); }
}

export function writeProgress({ file, progress, fsImpl = fs }) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, JSON.stringify(normalizeProgress(progress), null, 2) + '\n');
}

const action = (id, label, primary = false, needs) => ({ id, label, primary, ...(needs ? { needs } : {}) });

function depItems(deps) {
  return deps.map((d) => {
    const name = DEP_LABELS[d.name] ?? d.name;
    if (d.action === 'install') return { id: d.name, name, status: d.required ? 'failed' : 'warn', detail: 'Not installed' };
    if (d.action === 'update-available') return { id: d.name, name, status: 'warn', detail: `${firstLine(d.installed)}, update available${d.latest ? ` (${d.latest})` : ''}` };
    return { id: d.name, name, status: 'ok', detail: firstLine(d.installed) || 'Installed' };
  });
}

const firstLine = (s) => String(s ?? '').split('\n')[0].trim();

function worst(items) {
  if (items.some((i) => i.status === 'failed')) return 'failed';
  if (items.some((i) => i.status === 'warn')) return 'warn';
  return 'ok';
}

// Each builder returns the step as it stands before progress, busy and the last
// action result are applied.
const BUILDERS = {
  welcome: ({ progress }) => ({
    title: 'Welcome',
    summary: 'This wizard installs the tools GLMPS needs, signs you in to Claude and GitHub, connects Slack and links GLMPS to Claude Code.',
    status: progress.completed.includes('welcome') ? 'ok' : 'todo',
    detail: 'It takes a few minutes. You can skip any step and run the wizard again from the tray menu.',
    actions: [action('begin', 'Get started', true)],
  }),

  deps: ({ status }) => {
    const items = depItems(status.deps ?? []);
    const missing = (status.deps ?? []).filter((d) => d.action === 'install');
    const outdated = (status.deps ?? []).filter((d) => d.action === 'update-available');
    const state = items.some((i) => i.status === 'failed') ? 'todo' : worst(items);
    const actions = [];
    if (missing.length) actions.push(action('install-missing', 'Install missing tools', true));
    if (outdated.length) actions.push(action('update-all', 'Update outdated tools', !missing.length));
    for (const d of missing) actions.push(action(`install-${d.name}`, `Install ${DEP_LABELS[d.name] ?? d.name}`));
    for (const d of outdated) actions.push(action(`update-${d.name}`, `Update ${DEP_LABELS[d.name] ?? d.name}`));
    actions.push(action('recheck', 'Check again'));
    return {
      title: 'Tools',
      summary: missing.length
        ? `${missing.length} tool${missing.length === 1 ? '' : 's'} to install. Each opens a console window and may ask for permission.`
        : 'The tools GLMPS uses are installed.',
      status: state,
      detail: missing.length || outdated.length ? '' : 'Nothing to install.',
      items,
      actions,
    };
  },

  claude: ({ status }) => {
    const c = status.claude ?? {};
    const actions = [];
    if (!c.installed) actions.push(action('recheck', 'Check again'));
    else if (!c.signedIn) actions.push(action('sign-in', 'Sign in to Claude', true), action('recheck', 'Check again'));
    else actions.push(action('recheck', 'Check again'));
    return {
      title: 'Claude account',
      summary: c.signedIn ? 'Claude Code is signed in.' : 'Sign in to the Claude account GLMPS agents run under.',
      status: c.signedIn ? 'ok' : 'todo',
      detail: !c.installed ? 'Claude Code is not installed yet. Install it in the Tools step first.'
        : c.signedIn ? '' : 'A console window opens and a browser tab asks you to approve the sign-in.',
      actions,
    };
  },

  github: ({ status }) => {
    const g = status.github ?? {};
    const missing = g.missingScopes ?? [];
    const actions = [];
    let state = 'todo';
    let detail = '';
    if (!g.installed) detail = 'The GitHub CLI is not installed yet. Install it in the Tools step first.';
    else if (!g.signedIn) {
      detail = 'A console window opens and a browser tab asks you to approve the sign-in with the repo, workflow and read:org permissions.';
      actions.push(action('sign-in', 'Sign in to GitHub', true));
    } else if (missing.length) {
      state = 'warn';
      detail = `Signed in, but the token lacks: ${missing.join(', ')}.`;
      actions.push(action('refresh-scopes', 'Grant missing permissions', true));
    } else state = 'ok';
    actions.push(action('recheck', 'Check again'));
    return {
      title: 'GitHub',
      summary: state === 'ok' ? 'GitHub is signed in with the permissions GLMPS needs.' : 'Sign in to GitHub so GLMPS can open and merge pull requests.',
      status: state,
      detail,
      items: g.signedIn ? [{ name: 'Permissions', status: missing.length ? 'warn' : 'ok', detail: (g.scopes ?? []).join(', ') || 'Could not be read' }] : undefined,
      actions,
    };
  },

  slack: ({ status }) => {
    const rejected = status.slack?.saved === true && status.slack.live?.ok === false && !status.slack.live.unreachable;
    // Unchecked saved tokens still read OK here: the first probe is offline by design.
    const saved = status.slack?.saved === true && !rejected;
    return {
      title: 'Slack',
      summary: saved ? 'Slack tokens are saved. Connect again to refresh the channels or change who is authorized.' : 'Create the Riker app in your workspace, then paste its two tokens.',
      status: saved ? 'ok' : 'todo',
      detail: saved ? '' : rejected
        ? `Slack rejected the saved tokens (${status.slack.live.error}). Paste a fresh bot token (xoxb-) and app-level token (xapp-) with connections:write.`
        : 'Open Slack\'s create-app page, install the app to your workspace, then paste the bot token (xoxb-) and an app-level token (xapp-).',
      actions: [action('connect', saved ? 'Connect again' : 'Connect Slack', !saved, ['botToken', 'appToken', 'email', 'memberId'])],
    };
  },

  ide: ({ status }) => {
    const installed = status.hooks?.installed === true;
    return {
      title: 'Claude Code helper',
      summary: installed ? 'The GLMPS hooks and status line are installed in Claude Code.' : 'Install the GLMPS hooks and status line into Claude Code so sessions show up in the dashboard.',
      status: installed ? 'ok' : 'todo',
      detail: installed ? '' : 'This edits your Claude Code settings file, keeping a backup.',
      actions: [action('install-hooks', installed ? 'Reinstall' : 'Install into Claude Code', !installed)],
    };
  },

  editor: ({ status }) => {
    const e = editorState(status);
    if (!e.rows) {
      return { title: 'Default IDE', summary: 'Choose the IDE agent sessions open in.', status: 'warn', detail: 'This GLMPS cannot list your IDEs yet. Update GLMPS, then run the wizard again.', actions: [action('recheck', 'Check again')] };
    }
    const items = e.rows.map((r) => {
      const isPick = r.id === e.pick;
      const base = r.id === 'native-terminal' ? 'Always available' : !r.installed ? 'Not installed' : r.companion ? 'Installed, GLMPS extension ready' : 'Installed, GLMPS extension not installed';
      return { name: r.label, status: r.id === 'native-terminal' || (r.installed && r.companion) ? 'ok' : 'warn', detail: isPick ? `${base}, default` : base };
    });
    const actions = [];
    if (e.pickRow?.installed && e.pickRow.id !== 'native-terminal' && !e.pickRow.companion) actions.push(action('install-companion', `Install the GLMPS extension into ${e.pickRow.label}`, true));
    for (const r of e.rows) if (r.installed) actions.push(action(`choose-${r.id}`, `Use ${r.label}`));
    actions.push(action('recheck', 'Check again'));
    return {
      title: 'Default IDE',
      summary: e.ready ? `Agent sessions and Open in editor use ${e.pickRow.label}.` : 'Choose the IDE agent sessions and Open in editor use. One choice sets both.',
      status: e.ready ? 'ok' : 'todo',
      detail: e.ready ? '' : !e.pick ? 'Pick one below. A closed IDE is started for you; if it cannot be, the session opens in a native terminal.'
        : !e.pickRow?.installed ? `${e.pickRow?.label ?? e.pick} is not installed. Choose another IDE.`
          : `${e.pickRow.label} needs the GLMPS extension before sessions can open in it.`,
      items,
      actions,
    };
  },

  repos: ({ status }) => {
    const p = status.profile ?? {};
    return {
      title: 'Repositories',
      summary: p.exists ? 'GLMPS has a profile of your repositories.' : 'Point GLMPS at the folder that holds your projects and name your engagement.',
      status: p.exists ? 'ok' : 'todo',
      detail: p.exists ? (p.path ?? '') : 'GLMPS scans the folder for git repositories and writes a profile. It never changes them.',
      actions: [action('scan', p.exists ? 'Scan again' : 'Find my repositories', !p.exists, ['folder', 'engagement'])],
    };
  },

  health: ({ status }) => {
    const deps = status.deps ?? [];
    const requiredDown = deps.some((d) => d.required && d.action === 'install');
    const items = [
      { name: 'Required tools', status: requiredDown ? 'failed' : 'ok', detail: requiredDown ? 'Git or Node.js is missing' : 'Installed' },
      { name: 'Claude Code', status: status.claude?.installed && status.claude?.signedIn ? 'ok' : 'warn', detail: !status.claude?.installed ? 'Not installed' : status.claude.signedIn ? 'Signed in' : 'Not signed in' },
      { name: 'GitHub', status: status.github?.signedIn && !(status.github.missingScopes ?? []).length ? 'ok' : 'warn', detail: !status.github?.installed ? 'Not installed' : !status.github.signedIn ? 'Not signed in' : (status.github.missingScopes ?? []).length ? `Missing ${status.github.missingScopes.join(', ')}` : 'Signed in' },
      slackRow(status.slack),
      { name: 'Claude Code helper', status: status.hooks?.installed ? 'ok' : 'warn', detail: status.hooks?.installed ? 'Installed' : 'Not installed' },
      editorRow(status),
      { name: 'Repositories', status: status.profile?.exists ? 'ok' : 'warn', detail: status.profile?.exists ? 'Profile written' : 'Not scanned' },
    ];
    const state = worst(items);
    return {
      title: 'Ready check',
      summary: state === 'ok' ? 'Everything is set up.' : state === 'failed' ? 'A required tool is missing. Go back to the Tools step.' : 'GLMPS will run. Some optional parts are not set up yet.',
      status: state,
      detail: '',
      items,
      actions: [action('recheck', 'Run checks again')],
    };
  },
};

// The pick is usable when it is the native terminal, or an installed IDE that
// already has the companion.
function editorState(status) {
  const rows = Array.isArray(status.editors) ? status.editors : null;
  const pick = status.editorPick?.lastTarget ?? null;
  const pickRow = rows?.find((r) => r.id === pick) ?? null;
  const ready = Boolean(pickRow && (pick === 'native-terminal' || (pickRow.installed && pickRow.companion)));
  return { rows, pick, pickRow, ready };
}

function editorRow(status) {
  const e = editorState(status);
  const name = 'Default IDE';
  if (!e.rows) return { name, status: 'warn', detail: 'Not reported by this GLMPS' };
  if (!e.pick) return { name, status: 'warn', detail: 'Not chosen' };
  if (e.ready) return { name, status: 'ok', detail: e.pickRow.label };
  const label = e.pickRow?.label ?? e.pick;
  return { name, status: 'warn', detail: e.pickRow?.installed ? `${label}, GLMPS extension not installed` : `${label} is not installed` };
}

function slackRow(slack) {
  if (!slack?.saved) return { name: 'Slack', status: 'warn', detail: 'Not connected' };
  if (slack.live?.ok === true) return { name: 'Slack', status: 'ok', detail: 'Connected' };
  if (slack.live?.unreachable) return { name: 'Slack', status: 'warn', detail: 'Tokens saved, Slack could not be reached to check them' };
  if (slack.live) return { name: 'Slack', status: 'warn', detail: `Slack rejected the saved tokens (${slack.live.error})` };
  return { name: 'Slack', status: 'warn', detail: 'Tokens saved, not checked with Slack yet' };
}

function finishStep(id, built, { progress, running, results }) {
  const last = results?.[id];
  let status = built.status;
  let detail = built.detail;
  if (last?.message) detail = last.message;
  if (last && last.ok === false && status !== 'ok') status = 'failed';
  if (progress.skipped.includes(id) && status !== 'ok') status = 'skipped';
  if (running === id) status = 'running';
  const actions = built.actions.map((a) => ({ ...a }));
  if (SKIPPABLE.has(id)) actions.push(action('skip', 'Skip'));
  return { id, title: built.title, summary: built.summary, status, detail, ...(built.items ? { items: built.items } : {}), actions };
}

export function buildState({ status, progress, busy = false, running = null, results = {}, launchAtLogin = true }) {
  const st = status && typeof status === 'object' ? status : {};
  const prog = normalizeProgress(progress);
  const steps = STEP_ORDER.map((id) => finishStep(id, BUILDERS[id]({ status: st, progress: prog }), { progress: prog, running, results }));
  // A step is behind the user once it is ok, warn or skipped; the wizard
  // stops at the first one that is not.
  const settled = new Set(steps.filter((x) => ['ok', 'warn', 'skipped'].includes(x.status)).map((x) => x.id));
  const currentId = STEP_ORDER.find((id) => !settled.has(id)) ?? 'health';
  return {
    steps,
    currentId,
    complete: STEP_ORDER.filter((id) => id !== 'health').every((id) => settled.has(id)),
    busy: Boolean(busy),
    launchAtLogin: Boolean(launchAtLogin),
  };
}
