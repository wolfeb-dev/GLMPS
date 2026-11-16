import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseVersion, mountVersion } from '../../web/shared/version-label.js';

test('parseVersion splits <version>+<sha> and tolerates anything else', () => {
  assert.deepEqual(parseVersion('2.1.0+abc1234'), { version: '2.1.0', sha: 'abc1234' });
  assert.deepEqual(parseVersion('2.1.0'), { version: '2.1.0', sha: '' });
  assert.deepEqual(parseVersion('2.1.0+unknown'), { version: '2.1.0', sha: '' });
  assert.equal(parseVersion(undefined), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion('<img onerror=x>'), null);
});

function el() {
  return { textContent: '', title: '', hidden: true, innerHTMLWrites: 0, set innerHTML(v) { this.innerHTMLWrites += 1; } };
}

test('mountVersion shows v<version> via textContent with the sha as the tooltip', async () => {
  const e = el();
  await mountVersion(e, async () => ({ ok: true, json: async () => ({ version: '2.1.0+abc1234' }) }));
  assert.equal(e.textContent, 'v2.1.0');
  assert.equal(e.title, 'commit abc1234');
  assert.equal(e.hidden, false);
  assert.equal(e.innerHTMLWrites, 0);
});

test('mountVersion stays hidden when /healthz fails or has no version (fail open)', async () => {
  for (const f of [async () => { throw new Error('down'); }, async () => ({ ok: false }), async () => ({ ok: true, json: async () => ({ status: 'up' }) })]) {
    const e = el();
    await mountVersion(e, f);
    assert.equal(e.hidden, true);
    assert.equal(e.textContent, '');
  }
});

test('the header carries the version slot and app.js mounts it', () => {
  assert.match(fs.readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8'), /id="brand-version"/);
  assert.match(fs.readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8'), /mountVersion\(/);
});
