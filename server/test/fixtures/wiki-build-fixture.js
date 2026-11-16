// server/test/fixtures/wiki-build-fixture.js
// A two-section build as scripts/wiki-build-cli.mjs would write it, returning
// the same summary shape as its WIKI_RESULT line. stub: true writes llm:false
// sections, which the checker's "sections" rule rejects.
import fs from 'node:fs';
import path from 'node:path';

export function writeFixtureBuild(buildDir, { headSha, graphFingerprint = 'g1:fixture', stub = false }) {
  fs.mkdirSync(buildDir, { recursive: true });
  const sections = ['server', 'hooks'].map(slug => ({ slug, title: slug, llm: !stub, contentHash: `h-${slug}`, related: [], backlinks: [] }));
  fs.writeFileSync(path.join(buildDir, 'manifest.json'), JSON.stringify({ builtAtCommit: headSha, graphFingerprint, generatedAt: `g-${path.basename(buildDir)}`, sections }));
  for (const s of sections) fs.writeFileSync(path.join(buildDir, `${s.slug}.html`), `<article><h1>${s.slug}</h1><p>ok</p></article>`);
  return { sections: 2, llmSections: stub ? 0 : 2, modelCalls: 2, builtAtCommit: headSha, graphFingerprint, modelErrors: [] };
}
