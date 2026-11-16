// server/lib/kernel/tap-git-clones.js
// The server's own copies of the repos its clients report (card
// glmps-2-0-runtime-40): commit history and "is the client's HEAD pushed" come
// from the server's disk, never from the client. A remote that matches one of
// the server's own checkouts is read from there and never fetched here (the
// operator's checkouts are read-only input; the merge queue fetches its own).
// Every other remote on an allowed host gets a bare mirror clone under
// <stateDir>/git-clones/<host>/<owner>/<repo>.git, refreshed each run.
//
// `git` runs the network calls (clone, fetch): the desktop shell in service
// mode, where the operator's GitHub sign-in lives, a direct execFile otherwise.
// `read` runs local reads and is always direct. Both resolve { status, stdout,
// stderr }; `git` rejects only when the call could not be made at all.
import fs from 'node:fs';
import path from 'node:path';
import { canonicalRemote } from './tap-git.js';
import { isGitopsInfraError } from '../orchestration/gitops-broker.js';

export const MAX_CLONES_PER_RUN = 3;
const MAX_HEADS_PER_REMOTE = 500;
const ERROR_MAX = 300;

const oneLine = (text) => String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop()?.slice(0, ERROR_MAX) || 'git failed';

export function cloneDirFor(clonesDir, canon) {
  return path.join(clonesDir, canon.host, canon.owner, `${canon.repo}.git`);
}

export function createTapGitClonesLoop({
  remotes, serverCheckouts = () => [], clonesDir, git, read, now = Date.now, writeState, readState = () => null,
  hosts = ['github.com'], urlFor = (canon) => canon.url,
}) {
  const allowed = new Set(hosts.map((h) => String(h).toLowerCase()));

  async function pushedHeads(dir, heads) {
    const out = {};
    for (const sha of heads.slice(0, MAX_HEADS_PER_REMOTE)) {
      const r = await read(['-c', `safe.directory=${dir}`, '--no-optional-locks', '-C', dir, 'cat-file', '-e', `${sha}^{commit}`], { cwd: dir });
      out[sha] = r.status === 0;
    }
    return out;
  }

  const self = {
    maker: async () => {
      const all = remotes();
      if (!all.length) return { outcome: 'nothing-to-do' };
      const prev = readState()?.remotes ?? {};
      const checkouts = new Map();
      for (const c of serverCheckouts()) {
        const k = canonicalRemote(c?.remote)?.key;
        if (k && typeof c.path === 'string' && !checkouts.has(k)) checkouts.set(k, c.path);
      }
      const state = { ts: now(), remotes: {} };
      const expected = [];
      let attempted = 0; let infra = 0; let clones = 0;
      for (const r of all) {
        const heads = [...new Set(r.clients.flatMap((c) => c.heads))];
        if (!allowed.has(r.host)) {
          state.remotes[r.key] = { source: null, path: null, lastFetchTs: null, error: null, heads: {}, skipped: 'host not allowed' };
          continue;
        }
        expected.push(r.key);
        const row = { source: null, path: null, lastFetchTs: null, error: null, heads: {} };
        state.remotes[r.key] = row;
        try {
          const own = checkouts.get(r.key);
          if (own) {
            Object.assign(row, { source: 'checkout', path: own });
            row.heads = await pushedHeads(own, heads);
            continue;
          }
          const dest = cloneDirFor(clonesDir, r);
          const exists = fs.existsSync(path.join(dest, 'HEAD'));
          row.path = dest;
          row.lastFetchTs = prev[r.key]?.lastFetchTs ?? null;
          if (!exists && clones >= MAX_CLONES_PER_RUN) { row.pending = true; continue; }
          row.source = 'clone';
          attempted++;
          try {
            let res;
            if (exists) res = await git(['fetch', '-q', '--prune', 'origin'], { cwd: dest });
            else { clones++; res = await git(['clone', '--mirror', '-q', urlFor(r), dest], { cwd: clonesDir }); }
            if (res.status === 0) row.lastFetchTs = now();
            else row.error = oneLine(res.stderr);
          } catch (e) {
            if (isGitopsInfraError(e)) infra++;
            row.error = oneLine(e?.message);
          }
          if (fs.existsSync(path.join(dest, 'HEAD'))) row.heads = await pushedHeads(dest, heads);
          else row.source = null;
        } catch (e) {
          row.error = oneLine(e?.message);
        }
      }
      if (attempted > 0 && infra === attempted) {
        writeState(state);
        throw new Error('no-shell');
      }
      return { outcome: 'done', result: { state, expected } };
    },
    checker: async ({ state, expected }) => {
      const missing = expected.filter((k) => !state.remotes[k]);
      if (missing.length) return { ok: false, reason: `no state for ${missing.length} remote(s): ${missing.slice(0, 3).join(', ')}` };
      const broken = expected.filter((k) => state.remotes[k].error);
      if (expected.length && broken.length > expected.length / 2) return { ok: false, reason: `${broken.length} of ${expected.length} remotes failed to update` };
      return { ok: true, verifierRef: `git-clones@${expected.length}` };
    },
    onVerified: async ({ state }) => { writeState(state); },
  };
  return self;
}
