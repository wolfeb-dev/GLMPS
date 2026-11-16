// server/lib/scut/relay.js
// How an agent's own words reach its Slack thread whole.
//
// The relay used to be one line in server.js: `body.slice(0, 1500)`. That is a
// silent, mid-word cut, and it was losing most of every substantial reply - on
// the last Slack thread before this landed, 8 of 10 agent devlogs were over the
// cap and the longest was 6213 characters, so roughly three quarters of it never
// arrived. Slack's own limit for chat.postMessage `text` is 40,000 characters,
// so nothing about that cap came from Slack.
//
// Two pieces, both pure/injectable so they unit-test without a network:
//   splitRelayText  - one body -> ordered chunks that keep every character,
//                     cut on paragraph/line/word boundaries, numbered (i/n),
//                     and STATING the loss if a body is past all reasonable
//                     budget rather than dropping it in silence.
//   createRelayQueue - serializes posts per room so chunk 2 cannot overtake
//                     chunk 1, and two quick devlogs cannot interleave.

/** Per-message character budget. Well under Slack's 40,000, comfortably over a normal devlog. */
export const RELAY_CHUNK_LIMIT = 3500;
/** Most messages one relayed body may become: ~21k characters before the overflow marker. */
export const RELAY_MAX_CHUNKS = 6;

// Room for the "(i/n) " prefix, which is added after splitting: the widest
// realistic marker is "(10/10) ", 8 characters.
const PREFIX_RESERVE = 8;
// Only accept a boundary this far into the window; below it, a "nice" split
// wastes most of a message and doubles the message count for no gain.
const MIN_FILL = 0.5;

function overflowMarker(n) {
  return `\n[... ${n} more characters - full text in the glmps devlog]`;
}

/**
 * Where to cut `text` so the piece is at most `window` characters: the last
 * paragraph break, else the last line break, else the last space, else a hard
 * cut at the window (a single unbroken run longer than a whole message).
 * Returns { end, next } - `end` ends the piece, `next` starts the remainder,
 * so the whitespace that was split on is not emitted twice.
 */
function findBreak(text, window) {
  const head = text.slice(0, window + 1);
  const floor = Math.floor(window * MIN_FILL);
  const para = head.lastIndexOf('\n\n');
  if (para >= floor) return { end: para, next: para + 2 };
  const line = head.lastIndexOf('\n');
  if (line >= floor) return { end: line, next: line + 1 };
  const space = head.lastIndexOf(' ');
  if (space >= floor) return { end: space, next: space + 1 };
  return { end: window, next: window };
}

/**
 * Split one relayed body into ordered Slack-sized chunks.
 * Short bodies (<= limit) come back as a single chunk, byte-identical to what
 * the agent wrote - the overwhelming majority of posts, unchanged.
 *
 * @param {string} text
 * @param {{limit?:number, maxChunks?:number}} [opts]
 * @returns {string[]}
 */
export function splitRelayText(text, { limit = RELAY_CHUNK_LIMIT, maxChunks = RELAY_MAX_CHUNKS } = {}) {
  if (typeof text !== 'string') return [];
  const body = text.trim();
  if (!body) return [];
  if (body.length <= limit) return [body];

  const window = Math.max(1, limit - PREFIX_RESERVE);
  const pieces = [];
  let rest = body;

  while (rest.length) {
    if (rest.length <= window) { pieces.push(rest); break; }

    if (pieces.length === maxChunks - 1) {
      // Last message we are allowed: keep what fits alongside a marker that
      // says exactly how much did not, so the reader knows text is missing
      // and where to find it. The marker's own length depends on the number
      // it prints, so size it against the worst case (the whole remainder).
      const markerLen = overflowMarker(rest.length).length;
      const keep = Math.max(0, window - markerLen);
      const cut = keep > 0 ? findBreak(rest, keep) : { end: 0, next: 0 };
      const piece = rest.slice(0, cut.end).trimEnd();
      pieces.push(piece + overflowMarker(rest.length - cut.next));
      break;
    }

    const { end, next } = findBreak(rest, window);
    pieces.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(next);
  }

  if (pieces.length === 1) return pieces;
  return pieces.map((p, i) => `(${i + 1}/${pieces.length}) ${p}`);
}

/**
 * A tiny per-key promise chain. `run` never rejects and never lets one failed
 * job cancel the ones queued behind it: a Slack error costs that message, not
 * the rest of the conversation. Chains prune themselves once settled, so the
 * map cannot grow with every ticket the server ever sees.
 *
 * @param {{onError?:(e:any)=>void}} [opts]
 */
export function createRelayQueue({ onError = () => {} } = {}) {
  const chains = new Map();
  return {
    run(key, fn) {
      const prev = chains.get(key) ?? Promise.resolve();
      const done = prev.then(() => fn()).catch((e) => { try { onError(e); } catch { /* never throw at the caller */ } });
      const tracked = done.then(() => { if (chains.get(key) === tracked) chains.delete(key); });
      chains.set(key, tracked);
      return tracked;
    },
    /** Resolves when everything queued for this key so far has settled. */
    drain(key) { return chains.get(key) ?? Promise.resolve(); },
    /** Live chain count - exposed so a test can prove the map is pruned. */
    size() { return chains.size; },
  };
}
