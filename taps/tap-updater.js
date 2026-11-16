// taps/tap-updater.js
// The tap updates itself when idle, after checking the hash (card
// glmps-2-0-runtime-67; corpus spec "Upgrades"). The server names its published
// release in every heartbeat and 426 answer; when that commit differs from the
// installed bundle's and the agent is idle, the archive is downloaded with the
// client token, checked against the advertised SHA-256, unpacked, and checked
// against the signer pinned by the INSTALLED tap before any file is replaced.
import crypto from 'node:crypto';
import nodeFs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { TAP_PROTOCOL, TAP_PROTOCOL_HEADER } from '../server/lib/kernel/tap-protocol.js';
import { SIGNER_FILE, CATALOG_FILE, readPin, verifyTapPayload } from './tap-signature.js';
import { LOGON_TASK_NAME } from './tap-logon-task.js';
import { QUEUE_FILE, REJECTED_FILE } from './tap-relay.js';

export const UPDATE_PATH = '/api/tap/download/update';
export const MANIFEST_FILE = 'tap-manifest.json';
export const UPDATE_DIR = 'update';
export const OLD_SUFFIX = '.tap-old';
export const RETRY_MS = 10 * 60_000;
const SWAP_WAIT_TRIES = 60;
const SWAP_WAIT_MS = 500;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
// Files every bundle carries beside its manifest entries (apps/tap/scripts/build-tap.mjs, release-tap.mjs).
const FIXED_FILES = ['node.exe', 'package.json', MANIFEST_FILE, SIGNER_FILE, CATALOG_FILE];
// What the agent owns at runtime in the same folder; an update never writes these.
const HOME_DATA = new Set(['token.dpapi', 'tap-config.json', 'spool', UPDATE_DIR, 'logs', QUEUE_FILE, REJECTED_FILE]);
const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{4,40}$/i;

/** The release a server advertises, or null when it is not usable. */
export function validateAdvert(a) {
  if (!a || typeof a !== 'object') return null;
  if (typeof a.version !== 'string' || typeof a.commit !== 'string' || !COMMIT_RE.test(a.commit)) return null;
  if (!HEX64.test(String(a.sha256)) || !Number.isSafeInteger(a.size) || a.size < 1 || a.size > MAX_ARCHIVE_BYTES) return null;
  return { version: a.version, commit: a.commit, sha256: a.sha256, size: a.size };
}

function readManifest(dir, fs = nodeFs) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'));
  if (!m || typeof m.commit !== 'string' || !m.files || typeof m.files !== 'object') throw new Error(`${MANIFEST_FILE} has no commit or file list`);
  return m;
}
const payloadSet = (m) => new Set([...Object.keys(m.files), ...FIXED_FILES]);

function listFiles(dir, fs = nodeFs, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, fs, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/** Deletes the files a previous update set aside. Run at agent start, when nothing holds them. */
export function cleanupOld(home, { fs = nodeFs, log = () => {} } = {}) {
  let removed = 0, kept = 0;
  const walk = (dir, top) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (top && HOME_DATA.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, false);
      else if (e.name.endsWith(OLD_SUFFIX)) {
        try { fs.rmSync(full, { force: true }); removed++; } catch (err) { kept++; log(`[tap-updater] could not remove ${full}: ${err.code ?? err.message}`); }
      }
    }
  };
  walk(home, true);
  return { removed, kept };
}

/** Windows' own bsdtar reads zip and refuses entries that climb out of the target. */
export function tarExtractor({ spawn = spawnSync, env = process.env } = {}) {
  const tar = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return (zip, dir) => {
    const r = spawn(tar, ['-x', '-f', zip, '-C', dir], { windowsHide: true, encoding: 'utf8' });
    if (r.error || r.status !== 0) return { error: `tar could not unpack the update (${r.error ? r.error.message : `exit ${r.status}`}): ${String(r.stderr ?? '').trim().slice(0, 300)}` };
    return { ok: true };
  };
}

// Waits for this process to exit, then starts the logon task through the Task
// Scheduler COM API. No child console process is started, so nothing flashes.
const RESTART = '$ErrorActionPreference="Stop";try{$p=[int]$env:GLMPS_TAP_PID;$end=(Get-Date).AddSeconds(60);'
  + 'while((Get-Process -Id $p -ErrorAction SilentlyContinue) -and (Get-Date) -lt $end){Start-Sleep -Milliseconds 500};'
  + '$n=$env:GLMPS_TAP_TASK;$i=$n.LastIndexOf([char]92);$s=New-Object -ComObject Schedule.Service;$s.Connect();'
  + '$t=$s.GetFolder($n.Substring(0,[Math]::Max($i,1))).GetTask($n.Substring($i+1));[void]$t.Run($null);'
  + 'Add-Content -LiteralPath $env:GLMPS_TAP_LOG -Value ((Get-Date).ToString("o")+" started "+$n)}'
  + 'catch{Add-Content -LiteralPath $env:GLMPS_TAP_LOG -Value ((Get-Date).ToString("o")+" restart failed: "+$_.Exception.Message)}';

/** Hands the restart to a hidden helper; the caller then exits so the task can start a new agent. */
export function logonTaskRestarter({ home, spawn = nodeSpawn, env = process.env, pid = process.pid, taskName = LOGON_TASK_NAME } = {}) {
  return () => {
    // Setup registers no task when GLMPS_TAP_HOME is set, so there is nothing to start.
    if (env.GLMPS_TAP_HOME) return { restarting: false, reason: 'GLMPS_TAP_HOME is set, so there is no logon task; restart the agent to run the update' };
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', RESTART], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...env, GLMPS_TAP_PID: String(pid), GLMPS_TAP_TASK: taskName, GLMPS_TAP_LOG: path.join(home, UPDATE_DIR, 'restart.log') },
    });
    child.unref();
    return { restarting: true };
  };
}

class Refusal extends Error {}
const refuse = (m) => { throw new Refusal(m); };

/**
 * offer(advert, {required}) records what the server publishes; maybeApply()
 * runs at most one update when idle. isIdle({required, inFlightOnly}) is the
 * agent's: a required (426-driven) update does not wait for empty queues.
 */
export function createUpdater({
  home, payloadRoot, fetch: fetchFn = globalThis.fetch, getCreds, isIdle, verify, extract = tarExtractor(), restart,
  fs = nodeFs, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.error, platform = process.platform,
}) {
  const st = { state: 'current', installedCommit: null, available: null, required: false, reason: null, lastCheckTs: null, lastResultTs: null };
  let installed = null;
  let refusedSha = null;
  let retryAt = 0;
  let running = null;

  if (path.resolve(payloadRoot) !== path.resolve(home)) {
    Object.assign(st, { state: 'disabled', reason: `not running from the tap home (${home}); an agent run from a checkout never rewrites it` });
  } else {
    try { installed = readManifest(home, fs); st.installedCommit = installed.commit; }
    catch (e) { Object.assign(st, { state: 'disabled', reason: `no readable ${MANIFEST_FILE} in ${home} (${e.code ?? e.message})` }); }
  }

  function offer(advert, { required = false } = {}) {
    if (st.state === 'disabled' || st.state === 'applied') return;
    st.lastCheckTs = now();
    const a = validateAdvert(advert);
    if (!a || a.commit === st.installedCommit) {
      if (st.state !== 'applying') Object.assign(st, { state: 'current', available: null, required: false, reason: null });
      return;
    }
    const fresh = st.available?.sha256 !== a.sha256;
    st.available = a;
    st.required = required;
    if (st.state === 'applying') return;
    if (a.sha256 === refusedSha) return;
    if (fresh || st.state === 'current') Object.assign(st, { state: 'available', reason: null });
  }

  async function download(a, dir) {
    const creds = getCreds();
    if (!creds) throw new Error('the tap is not paired, so it cannot fetch the update');
    const res = await fetchFn(`${creds.config.server}${UPDATE_PATH}`, {
      headers: { authorization: `Bearer ${creds.token}`, [TAP_PROTOCOL_HEADER]: String(TAP_PROTOCOL) },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (res.status !== 200) throw new Error(`the server answered ${res.status} to the update download`);
    const header = res.headers.get('x-content-sha256');
    if (header !== a.sha256) refuse(`the server's x-content-sha256 (${header || 'none'}) is not the advertised SHA-256 ${a.sha256}`);
    const zip = path.join(dir, 'download.zip');
    const h = crypto.createHash('sha256');
    let size = 0;
    const fd = fs.openSync(zip, 'w');
    try {
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > a.size) refuse(`the update is larger than the advertised ${a.size} bytes`);
        h.update(chunk);
        fs.writeSync(fd, chunk);
      }
    } finally { fs.closeSync(fd); }
    if (size !== a.size) throw new Error(`the download stopped at ${size} of ${a.size} bytes`);
    const got = h.digest('hex');
    if (got !== a.sha256) refuse(`the update's SHA-256 ${got} is not the advertised ${a.sha256}`);
    return zip;
  }

  function check(staged, a) {
    const files = listFiles(staged, fs);
    const owned = files.find((f) => HOME_DATA.has(f.split('/')[0]));
    if (owned) refuse(`the update would overwrite the tap's own ${owned.split('/')[0]}`);
    let pin;
    try { pin = readPin(home); } catch (e) { refuse(`the installed tap has no usable signer pin (${e.message})`); }
    const v = verifyTapPayload(staged, { pin, verify, platform });
    if (!v.ok) refuse(`the update failed its signature check: ${v.reason}`);
    let next;
    try { next = readPin(staged); } catch (e) { refuse(`the update has no usable signer pin (${e.message})`); }
    if (next.thumbprint !== pin.thumbprint || next.mode !== pin.mode) refuse(`the update re-pins its signer to ${next.thumbprint} (${next.mode}); a signer change needs a reinstall`);
    const m = readManifest(staged, fs);
    if (m.commit !== a.commit) refuse(`the update holds commit ${m.commit}, not the advertised ${a.commit}`);
    return { files, manifest: m };
  }

  // Every payload file's old copy is renamed aside (Windows allows that for a
  // running node.exe), then the new one renamed in; any failure undoes it all.
  function swap(staged, files, stale) {
    const done = [];
    try {
      for (const rel of files) {
        const dest = path.join(home, rel);
        const entry = { dest, aside: false, placed: false };
        done.push(entry);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (fs.existsSync(dest)) {
          fs.rmSync(dest + OLD_SUFFIX, { force: true });
          fs.renameSync(dest, dest + OLD_SUFFIX);
          entry.aside = true;
        }
        fs.renameSync(path.join(staged, rel), dest);
        entry.placed = true;
      }
      for (const rel of stale) {
        const dest = path.join(home, rel);
        if (!fs.existsSync(dest)) continue;
        const entry = { dest, aside: false, placed: false };
        done.push(entry);
        fs.rmSync(dest + OLD_SUFFIX, { force: true });
        fs.renameSync(dest, dest + OLD_SUFFIX);
        entry.aside = true;
      }
    } catch (e) {
      const stuck = [];
      for (const { dest, aside, placed } of done.reverse()) {
        try {
          if (placed) fs.rmSync(dest, { force: true });
          if (aside) fs.renameSync(dest + OLD_SUFFIX, dest);
        } catch (err) { stuck.push(`${dest}: ${err.code ?? err.message}`); }
      }
      if (stuck.length) throw new Error(`replacing the tap files failed (${e.code ?? e.message}) and ${stuck.length} could not be put back: ${stuck.slice(0, 3).join('; ')}; rerun the installer`);
      throw new Error(`replacing the tap files failed and every file was put back: ${e.code ?? ''} ${e.message}`.trim());
    }
  }

  async function waitInFlight(required) {
    for (let i = 0; i < SWAP_WAIT_TRIES; i++) {
      if (isIdle({ required, inFlightOnly: true })) return true;
      await sleep(SWAP_WAIT_MS);
    }
    return false;
  }

  async function apply(a, required) {
    const dir = path.join(home, UPDATE_DIR);
    const staged = path.join(dir, 'staged');
    const clean = () => { for (const p of [staged, path.join(dir, 'download.zip')]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} } };
    Object.assign(st, { state: 'applying', reason: null });
    try {
      clean();
      fs.mkdirSync(staged, { recursive: true });
      const zip = await download(a, dir);
      const x = extract(zip, staged);
      if (x?.error) throw new Error(x.error);
      const { files, manifest } = check(staged, a);
      const next = payloadSet(manifest);
      const stale = [...payloadSet(installed)].filter((f) => !next.has(f));
      if (!(await waitInFlight(required))) {
        Object.assign(st, { state: 'waiting-idle', reason: 'a request was still in flight when the update was ready; trying again at the next heartbeat' });
        return;
      }
      swap(staged, files, stale);
      const from = installed.commit;
      installed = manifest;
      st.installedCommit = manifest.commit;
      log(`[tap-updater] updated ${from} -> ${manifest.commit}`);
      const r = await restart({ from, to: manifest.commit });
      Object.assign(st, { state: 'applied', available: null, reason: r?.restarting === false ? `restart pending: ${r.reason}` : null });
    } catch (e) {
      if (e instanceof Refusal) {
        refusedSha = a.sha256;
        Object.assign(st, { state: 'refused', reason: e.message });
      } else {
        retryAt = now() + RETRY_MS;
        Object.assign(st, { state: 'failed', reason: e?.message || String(e) });
      }
      log(`[tap-updater] ${st.state}: ${st.reason}`);
    } finally {
      clean();
      st.lastResultTs = now();
    }
  }

  function maybeApply() {
    if (running) return running;
    const a = st.available;
    if (!a || st.state === 'disabled' || st.state === 'applied') return Promise.resolve(status());
    if (a.sha256 === refusedSha) return Promise.resolve(status());
    if (st.state === 'failed' && now() < retryAt) return Promise.resolve(status());
    if (!isIdle({ required: st.required, inFlightOnly: false })) {
      Object.assign(st, { state: 'waiting-idle', reason: st.required ? 'waiting for in-flight requests to finish' : 'waiting for the spool and relay queue to empty' });
      return Promise.resolve(status());
    }
    running = apply(a, st.required).then(status).finally(() => { running = null; });
    return running;
  }

  function status() {
    return { ...st, available: st.available ? { ...st.available } : null };
  }

  return { offer, maybeApply, status };
}
