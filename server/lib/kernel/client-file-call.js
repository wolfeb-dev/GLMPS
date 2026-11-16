// A file read, save or undo that runs on a paired client's machine: queued as a
// 'file' launch record, claimed and answered by that client's tap, awaited here.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const span = (ms) => (ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`);

export function createClientFileCall({ launchBroker, claimWaitMs = 10_000, totalMs = 20_000, pollMs = 50 }) {
  return async function call({ clientId, clientName, action }) {
    const { id } = launchBroker.enqueue({ origin: 'file', command: `file ${action.op}`, cwd: action.path, targetClient: clientId, action });
    const t0 = Date.now();
    const finish = (out) => { launchBroker.scrub(id); return out; };
    const giveUp = (why) => { launchBroker.fail(id, why); return finish({ status: 504, body: { error: why, client: clientName } }); };
    for (;;) {
      const rec = launchBroker.get(id);
      const waited = Date.now() - t0;
      if (!rec) return { status: 502, body: { error: 'the file call record disappeared' } };
      if (rec.state === 'done') {
        const r = rec.result;
        return finish(r && Number.isInteger(r.status) ? { status: r.status, body: r.body } : { status: 502, body: { error: `client ${clientName} answered without a result` } });
      }
      if (rec.state === 'failed') return finish({ status: 502, body: { error: rec.error || `client ${clientName} could not run the file action` } });
      if (rec.state === 'pending' && waited >= claimWaitMs) return giveUp(`client ${clientName} did not pick this up within ${span(claimWaitMs)}`);
      if (waited >= totalMs) return giveUp(`client ${clientName} did not answer within ${span(totalMs)}`);
      await sleep(pollMs);
    }
  };
}
