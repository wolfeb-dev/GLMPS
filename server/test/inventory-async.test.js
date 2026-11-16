import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanInventory, scanInventoryAsync } from '../lib/observability/inventory.js';

function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-inv-async-'));
  const put = (rel, text) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  for (let i = 0; i < 40; i++) put(`cache/mp/plug${i % 4}/1.0.${i}/skills/s${i}/SKILL.md`, `---\nname: s${i}\ndescription: d${i}\n---\n`);
  put('cache/mp/plug0/1.0.0/agents/a.md', '---\nname: a\n---\n');
  put('projects/D--/memory/note.md', '---\ndescription: a fact\n---\n');
  put('proj/CLAUDE.md', '# p');
  put('proj/.claude/agents/pa.md', '---\nname: pa\n---\n');
  put('proj/.agents/skills/ps/SKILL.md', '---\nname: ps\n---\n');
  put('claude/CLAUDE.md', '# g');
  put('claude/skills/us/SKILL.md', '---\nname: us\n---\n');
  return {
    tmp,
    opts: { pluginsCacheDir: path.join(tmp, 'cache'), projectsDir: path.join(tmp, 'projects'), projectRoots: [path.join(tmp, 'proj'), path.join(tmp, 'missing')], claudeDir: path.join(tmp, 'claude') },
  };
}

test('the async scan returns exactly what the sync scan returns', async () => {
  const { tmp, opts } = fixture();
  try {
    const sync = scanInventory(opts);
    assert.equal(sync.skills.length, 42);
    assert.deepEqual(await scanInventoryAsync(opts), sync);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the event loop keeps turning while the async scan runs', async () => {
  const { tmp, opts } = fixture();
  try {
    let turns = 0;
    let done = false;
    const spin = () => { if (!done) { turns++; setImmediate(spin); } };
    setImmediate(spin);
    await scanInventoryAsync(opts);
    done = true;
    assert.ok(turns > 10, `event loop turned only ${turns} times during the scan`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
