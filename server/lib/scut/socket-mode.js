// server/lib/scut/socket-mode.js
// Minimal zero-dep Slack Socket Mode client over Node's native WebSocket.
// Opens a connection via apps.connections.open (through the injected slack-web
// client), receives envelopes, ACKs them within Slack's window, and delivers
// parsed events (e.g. app_mention) to onEvent. The WebSocket factory is
// injectable so tests drive it with a fake - no network.
//
// Protocol: https://api.slack.com/apis/socket-mode
//  - envelopes: { type: 'hello' | 'events_api' | 'disconnect', envelope_id?, payload? }
//  - every envelope carrying an envelope_id must be acked: send { envelope_id }.
//  - 'disconnect' means Slack wants us to reconnect (open a fresh connection).
//
// Reconnect: Slack cycles this socket on its own schedule (a 'disconnect'
// envelope with reason refresh_requested every few hours is documented
// behavior, not an edge case), so a rejected apps.connections.open is a
// routine event, not a rare one. The retry loop below is UNBOUNDED - it
// never gives up - but every retry is gated behind an exponential, jittered,
// capped delay (skip-and-wait, in the same spirit as
// observability/source-guard.js's failing-source backoff, just modeled as
// an active retry loop here instead of a skip-until-nextRetryAt gate, since
// there is no polling caller to skip a turn for - we own the reconnect
// loop). Failure modes this guards against:
//  - a permanently-rejecting open() must be retried forever, not abandoned
//    after one attempt (the old bug: inbound died silently until a
//    restart, while outbound HTTP posting kept working);
//  - a socket that fails (or closes) immediately must not be hammered at
//    zero delay - each failure waits at least baseDelayMs before the next
//    attempt, growing exponentially up to maxDelayMs;
//  - a socket that OPENS fine and then closes almost immediately, on
//    repeat, is the same zero-delay hammering under a different mask: an
//    open() that never throws would otherwise reset the backoff on every
//    cycle. A connection only earns that reset if it SURVIVED for at least
//    stableMs - merely opening is not enough - so a flapping connection
//    still escalates the delay between attempts exactly like a flapping
//    failure does, while a connection that was actually healthy for a
//    while still recovers fast from a routine Slack-initiated cycle.

export function createSocketMode({
  web,
  wsFactory = (url) => new WebSocket(url),
  onEvent,
  log = () => {},
  onState = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
  now = () => Date.now(),
  maxDelayMs = 60000,
  baseDelayMs = 1000,
  stableMs = 30000,
} = {}) {
  let ws = null;
  let stopped = false;
  let connected = false;
  let attempt = 0; // consecutive unstable attempts since the last stable connection; reset only by a connection that survives stableMs
  let connectedAt = null; // when the current/most recent connection succeeded, or null if none ever has
  // Serializes envelope delivery: each event chains onto the tail of this
  // promise so two rapid mentions cannot interleave (one onEvent call fully
  // settles - success or failure - before the next one starts).
  let queue = Promise.resolve();

  // The shared backoff formula: exponential in attempt, capped, jittered by
  // a factor in [0.5, 1.5). Used both for a straight-up failing open() and
  // for an unstable (too-short-lived) connection.
  function nextDelay() {
    const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    return backoff * (0.5 + random());
  }

  async function open() {
    const res = await web.call('apps.connections.open');
    if (!res.url) throw new Error('apps.connections.open returned no url');
    const socket = wsFactory(res.url);
    socket.onmessage = (msg) => {
      let env;
      try { env = JSON.parse(msg.data); } catch { return undefined; }
      return handle(env);
    };
    socket.onclose = () => {
      connected = false;
      if (!stopped) reconnect();
    };
    socket.onerror = () => { /* onclose will follow and drive reconnect */ };
    ws = socket;
    if (stopped) {
      // stop() ran while this open() was already in flight. A stopped
      // client must not resurrect itself just because a slow connect
      // happened to land after the fact - close what just arrived and
      // report it as the failure it effectively is.
      ws.close?.();
      throw new Error('stopped while connecting');
    }
  }

  // Retries open() forever, waiting between attempts behind a jittered,
  // exponentially growing, capped delay. Resolves once connected; rejects
  // only when stop() cancels a retry that was already sleeping (or races an
  // in-flight open(), handled above). Does NOT reset attempt on success -
  // that only happens once the connection has proven itself stable (see
  // reconnect() below) - so a connect that is about to flap keeps the
  // climbing backoff it already earned.
  async function connectLoop() {
    for (;;) {
      try {
        await open();
        connectedAt = now();
        connected = true;
        onState({ connected: true, attempt, error: null });
        return;
      } catch (error) {
        attempt += 1;
        connected = false;
        onState({ connected: false, attempt, error });
        await sleep(nextDelay());
        if (stopped) throw new Error('stopped: reconnect cancelled');
      }
    }
  }

  function handle(env) {
    if (env.type === 'hello') return undefined;               // greeting: nothing to do
    if (env.type === 'disconnect') { ws?.close?.(); return undefined; } // -> onclose -> reconnect
    // Ack immediately, before delivery - Slack's 3s ack window is why ack
    // always comes first, regardless of how long the queued handler takes.
    if (env.envelope_id) ack(env.envelope_id);      // ack anything that needs it
    if (env.type === 'events_api') {
      const event = env.payload?.event;
      if (event) {
        // Slack's events_api payload carries `event_id`
        // as a SIBLING of `event`, not inside it - attached here so
        // engine.js's member_joined_channel dedup (event_ts is not always
        // present on that event type) has something stable to fall back to.
        // Never overwrites an `event_id` the inner event might already
        // carry (none does today, but this stays additive either way).
        const withId = env.payload?.event_id !== undefined && event.event_id === undefined
          ? { ...event, event_id: env.payload.event_id }
          : event;
        // Chain onto the queue rather than firing immediately, so a slow
        // handler for envelope N finishes before envelope N+1 starts. A
        // throwing/rejecting handler is caught here so it cannot wedge the
        // queue for whatever comes next.
        queue = queue.then(() => onEvent?.(withId)).catch((e) => log('onEvent threw: ' + (e?.message ?? e)));
        return queue;
      }
    }
    return undefined;
  }

  function ack(envelope_id) {
    try { ws.send(JSON.stringify({ envelope_id })); } catch (e) { log('ack failed: ' + (e?.message ?? e)); }
  }

  // Called when a previously-open connection ends. A connection that was up
  // for at least stableMs is treated like a success: attempt resets to 0
  // and the next open() is tried immediately, so a healthy long-running
  // session recovers fast from a routine Slack-initiated cycle. Anything
  // shorter is treated like a failure: attempt keeps climbing and the same
  // jittered backoff from connectLoop() gates the next attempt, so a
  // socket that keeps opening and immediately closing cannot hammer
  // apps.connections.open at zero delay.
  function reconnect() {
    if (stopped) return;
    const stable = connectedAt !== null && now() - connectedAt >= stableMs;
    attempt = stable ? 0 : attempt + 1;
    onState({ connected: false, attempt, error: null });
    log('socket closed; reconnecting');
    if (stable) {
      connectLoop().catch((e) => log('reconnect failed: ' + (e?.message ?? e)));
      return;
    }
    (async () => {
      await sleep(nextDelay());
      if (stopped) return;
      await connectLoop();
    })().catch((e) => log('reconnect failed: ' + (e?.message ?? e)));
  }

  return {
    start: connectLoop,
    stop() { stopped = true; connected = false; ws?.close?.(); },
    isConnected: () => connected,
    _handle: handle, // exposed for tests
  };
}
