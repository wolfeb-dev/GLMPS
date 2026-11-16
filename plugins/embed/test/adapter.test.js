import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAdapter } from '../../host.js';

const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

test('384-dim normalised vectors; related text scores above unrelated', { skip: !process.env.GLMPS_EMBED_MODEL_DIR && 'set GLMPS_EMBED_MODEL_DIR to run' }, async () => {
  const { createEmbedder } = await loadAdapter('embed');
  const e = await createEmbedder({ modelDir: process.env.GLMPS_EMBED_MODEL_DIR });
  const [a, b, c] = await e.embedDocuments(['The CI runs on Linux and Windows.', 'Which operating systems does CI use?', 'I like pancakes.']);
  assert.equal(a.length, 384);
  assert.ok(Math.abs(Math.hypot(...a) - 1) < 1e-3);
  assert.ok(cos(a, b) > cos(a, c) + 0.1);
  assert.deepEqual(await e.embedQuery('x'), await e.embedQuery('x'));
});
