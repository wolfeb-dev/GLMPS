export function bigBoard(n = 1500, devlogBytes = 3000) {
  const items = [];
  for (let i = 1; i <= n; i++) {
    items.push({
      id: `glmps-${i}`, project: 'glmps', title: `Card ${i}`, state: i % 5 === 0 ? 'queued' : 'done',
      prompt: 'p'.repeat(200), devLog: [{ by: 'agent', ts: '2026-10-26T00:00:00Z', text: 'd'.repeat(devlogBytes) }],
    });
  }
  return { items, paused: false, seq: n, seqs: { glmps: n } };
}
