// card glmps-2-0-runtime-77 AC-2 made the digest the dashboard's own grouping;
// card glmps-2-0-219 made it one morning post of the new rows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { claudeTmp } from './fixtures/claude-dir.js';

function quarantined(stateDir, items) {
  fs.mkdirSync(path.join(stateDir, 'backlog'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'backlog', 'store.json'), JSON.stringify({
    items: items.map(([id, title]) => ({ id, title, quarantined: true, provenance: { flags: ['x'] }, updatedTs: 1 })), seq: 0, seqs: {},
  }));
}

test('the digest posts once a day, and only the alerts that are new since the last one', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-digest-'));
  const stateDir = path.join(base, 'state'); fs.mkdirSync(stateDir);
  const claudeDir = claudeTmp();
  quarantined(stateDir, [['fix-1', 'Reviewed egress finding'], ['fix-2', 'Second finding']]);
  const configFile = path.join(base, 'config.json');
  // hour 0: due at any time of day, so the test does not depend on the clock.
  fs.writeFileSync(configFile, JSON.stringify({ alertDigest: { hour: 0 } }));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off' };
  const h = await startServer({ port: 0, env, configFile });
  const digestFile = path.join(stateDir, 'alert-digest.json');
  const read = () => JSON.parse(fs.readFileSync(digestFile, 'utf8'));
  try {
    const body = await (await fetch(`http://127.0.0.1:${h.port}/api/alerts`)).json();
    const poison = body.alerts.filter((a) => a.source === 'poison').map((a) => a.id);
    assert.equal(poison.length, 2);

    const run = await h.loopRegistry.runNow('alert-digest', {});
    assert.equal(run.outcome, 'done', JSON.stringify(run));
    const doc = read();
    for (const id of poison) assert.ok(doc.ids.includes(id), `${id} is recorded as seen`);
    assert.match(doc.posted, /new since the last digest/);
    assert.match(doc.posted, /Poison: 2/);

    assert.equal((await h.loopRegistry.runNow('alert-digest', {})).outcome, 'nothing-to-do', 'one post per local day');

    // The next day with nothing new: due, but nothing is posted.
    fs.writeFileSync(digestFile, JSON.stringify({ ...doc, day: '2000-01-01' }));
    assert.equal((await h.loopRegistry.runNow('alert-digest', {})).outcome, 'done');
    assert.equal(read().posted, null);

    // The next day with one poison row unseen: only that one is posted.
    fs.writeFileSync(digestFile, JSON.stringify({ ...doc, day: '2000-01-01', ids: doc.ids.filter((id) => id !== poison[1]) }));
    assert.equal((await h.loopRegistry.runNow('alert-digest', {})).outcome, 'done');
    assert.match(read().posted, /^Alerts: 1 new since the last digest \(1 warning\)/);
  } finally {
    await h.close();
    for (const d of [base, claudeDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }
});

test('the digest can be switched off', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-digest-off-'));
  const stateDir = path.join(base, 'state'); fs.mkdirSync(stateDir);
  const claudeDir = claudeTmp();
  const configFile = path.join(base, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ alertDigest: { enabled: false } }));
  const h = await startServer({ port: 0, env: { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off' }, configFile });
  try {
    assert.equal(h.loopRegistry.get('alert-digest') ?? null, null);
  } finally {
    await h.close();
    for (const d of [base, claudeDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }
});
