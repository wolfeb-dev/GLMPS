import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const DEFAULT_WORKER_FILE = fileURLToPath(new URL('./memory-worker.js', import.meta.url));

function stubMessage(init) {
  return init.stage === 'embed'
    ? 'mem0 plugin: configureHost was not called'
    : `mem0 plugin: failed to load (${init.reason})`;
}

function remoteError(e) {
  const err = new Error(e?.message ?? String(e));
  if (e?.code !== undefined) err.code = e.code;
  return err;
}

// The memory@1 surface (add/search/remove) over a worker thread. `ready` never
// rejects; a failed init is a value, and later calls reject with the same
// message the in-process stub used to give.
export function createMemoryWorker({ modelDir, dbDir, chatCompletion, pluginsDir, workerFile = DEFAULT_WORKER_FILE }) {
  let current = null;      // live worker state
  let initFailure = null;  // sticky: a missing model does not heal by respawning
  let nextId = 1;
  let closed = false;

  function spawn() {
    const worker = new Worker(workerFile, { workerData: { modelDir, dbDir, pluginsDir } });
    const st = { worker, pending: new Map(), settled: false, resolveInit: null, init: null, refs: 1 };
    st.init = new Promise((r) => { st.resolveInit = r; });
    const settle = (v) => { if (!st.settled) { st.settled = true; st.resolveInit(v); } };
    // An idle worker must not keep the host process alive; hold a ref only while
    // init or a call is outstanding.
    st.release = () => { if (--st.refs === 0) worker.unref(); };
    st.hold = () => { if (st.refs++ === 0) worker.ref(); };

    worker.on('message', (m) => {
      if (m.type === 'ready') { settle({ ok: true }); st.release(); return; }
      if (m.type === 'init-failed') {
        initFailure = { ok: false, stage: m.stage, reason: m.message };
        settle(initFailure);
        st.release();
        if (current === st) current = null;
        worker.terminate();
        return;
      }
      if (m.type === 'chat') {
        Promise.resolve().then(() => chatCompletion(m.body)).then(
          (value) => worker.postMessage({ type: 'chat-result', id: m.id, ok: true, value }),
          (e) => worker.postMessage({ type: 'chat-result', id: m.id, ok: false, error: String(e?.message || e) }),
        );
        return;
      }
      if (m.type === 'result') {
        const p = st.pending.get(m.id);
        if (!p) return;
        st.pending.delete(m.id);
        if (m.ok) p.resolve(m.value); else p.reject(remoteError(m.error));
        st.release();
      }
    });

    const die = (why) => {
      if (current === st) current = null;
      for (const p of st.pending.values()) p.reject(new Error(`memory worker ${why}`));
      st.pending.clear();
      settle({ ok: false, stage: 'load', reason: `memory worker ${why}` });
    };
    worker.on('error', (e) => die(`failed: ${e?.message ?? e}`));
    worker.on('exit', (code) => die(`exited unexpectedly (code ${code})`));
    return st;
  }

  function ensure() {
    if (initFailure) return null;
    if (!current) current = spawn();
    return current;
  }

  async function call(op, args) {
    if (closed) throw new Error('memory worker is closed');
    const st = ensure();
    if (!st) throw new Error(stubMessage(initFailure));
    const init = await st.init;
    if (!init.ok) throw new Error(stubMessage(init));
    return new Promise((resolve, reject) => {
      const id = nextId++;
      st.pending.set(id, { resolve, reject });
      st.hold();
      st.worker.postMessage({ type: 'call', id, op, args });
    });
  }

  const first = ensure();

  return {
    ready: first.init.then((r) => (r.ok ? { ok: true } : { ok: false, stage: r.stage, reason: r.reason })),
    add: (a) => call('add', a),
    search: (a) => call('search', a),
    remove: (a) => call('remove', a),
    async close() {
      closed = true;
      const st = current;
      current = null;
      if (st) await st.worker.terminate();
    },
  };
}
