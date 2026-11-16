// Who owns a session or a path: the pure decision every client-targeted route
// (resume, terminal, open-in-editor, file API) asks before acting. Lexical only;
// the server never stats a path that lives on a client.
import { splitNamespacedId } from './tap-mirror.js';

const ABS_RE = /^(?:[A-Za-z]:[\\/]|\/)/;
const flat = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** null when `p` is an acceptable absolute path, else the reason it is refused. */
export function pathIssue(p) {
  if (typeof p !== 'string' || !p || p.length > 4096 || /\0/.test(p)) return 'path must be an absolute path';
  if (/^[\\/]{2}/.test(p)) return 'UNC and device paths are not allowed';
  if (!ABS_RE.test(p)) return 'path must be an absolute path';
  if (p.split(/[\\/]/).includes('..')) return 'path must not contain ..';
  return null;
}

export function insideRoots(roots, p) {
  const f = flat(p);
  return (roots ?? []).some((r) => { const x = flat(r); return f === x || f.startsWith(`${x}/`); });
}

export const ownerOfSession = (id) => splitNamespacedId(id)?.clientId ?? null;

const live = (c) => c && c.paired && !c.revokedTs;

// Each client declares its own roots in its heartbeat, so a deeper root is no
// claim of ownership over another client's subtree (scan F8): any two live
// clients whose roots both cover the path are ambiguous, not longest-wins.
/** null, { clientId, client }, or { ambiguous: [clientIds] } when two live clients' roots cover the path. */
export function ownerOfPath(clients, p) {
  const hits = (clients ?? []).filter((c) => live(c) && insideRoots(c.projectRoots, p));
  if (!hits.length) return null;
  if (hits.length > 1) return { ambiguous: hits.map((c) => c.id) };
  return { clientId: hits[0].id, client: hits[0] };
}

const toClient = (c) => ({ target: 'client', clientId: c.id, client: c });

// `localRoots` are the server box's own editable and launch roots: a path inside
// one stays on the server unless the request names a client, so a laptop that
// declares the same root (or a whole drive) never captures the server's files.
export function resolveTarget({ clients = [], sessionId = null, paths = [], clientId = null, localRoots = [] } = {}) {
  const ps = paths.filter((p) => p != null);
  const issue = ps.map(pathIssue).find(Boolean);
  const pinned = (c) => {
    if (issue) return { refuse: 400, reason: issue };
    const out = ps.find((p) => !insideRoots(c.projectRoots, p));
    return out === undefined ? toClient(c) : { refuse: 403, reason: `path not owned by client ${c.id}` };
  };
  if (clientId) {
    const c = clients.find((x) => x.id === clientId);
    if (!c) return { refuse: 404, reason: 'unknown client' };
    if (!live(c)) return { refuse: 409, reason: 'client is not paired' };
    return pinned(c);
  }
  const owner = ownerOfSession(sessionId);
  if (owner) {
    const c = clients.find((x) => x.id === owner);
    if (!live(c)) return { refuse: 409, reason: 'client is not paired' };
    return pinned(c);
  }
  // An unprefixed id is the server box's own session: its cwd is a server path even
  // when a client declares the same drive-letter root, so path ownership never moves it.
  if (sessionId != null && sessionId !== '') return { target: 'local' };
  // A malformed path names no client, so the local branch refuses it with the same
  // answer it gives when no client is paired.
  if (issue) return { target: 'local' };
  const owners = new Map(); let unowned = false;
  for (const p of ps) {
    const o = insideRoots(localRoots, p) ? null : ownerOfPath(clients, p);
    if (!o) unowned = true;
    else if (o.ambiguous) return { refuse: 409, reason: `path is inside the project roots of both ${o.ambiguous.join(' and ')}; name one with clientId` };
    else owners.set(o.clientId, o.client);
  }
  if (!owners.size) return { target: 'local' };
  if (owners.size > 1 || unowned) return { refuse: 409, reason: 'paths belong to different machines' };
  return toClient([...owners.values()][0]);
}
