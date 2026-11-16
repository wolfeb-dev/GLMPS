// apps/shell/test/user-agent.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromeUserAgent } from '../src/lib/user-agent.js';

// electron-44.4.5 does not vendor a literal sample user-agent string (no
// "Chrome/" or "Electron/" token anywhere under docs/reference); the shape
// below - the Chromium UA with "<productName>/<version> Chrome/<ver>
// Electron/<ver>" spliced in before the trailing Safari token - is the
// documented default-session build order the rest of the ecosystem (Slack,
// Discord, VS Code) has shown in the wild. The parser below does not rely on
// that exact order: it keeps only the fixed Chromium anchors and drops
// everything else, so it holds even if Electron's own token order changes.
const REAL_ELECTRON_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) GLMPS 2.0/0.1.0 Chrome/140.0.7339.0 Electron/44.4.5 Safari/537.36';
const PLAIN_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.0 Safari/537.36';

test('strips the Electron and app-name tokens from a real Electron 44 user agent', () => {
  assert.equal(chromeUserAgent(REAL_ELECTRON_UA), PLAIN_CHROME_UA);
});

test('an app name with a space in it (this app\'s own productName, "GLMPS 2.0") is still fully removed', () => {
  // Regression: a naive split-on-space token filter would leave the "GLMPS"
  // half behind, since it has no "/version" suffix of its own.
  assert.ok(!chromeUserAgent(REAL_ELECTRON_UA).includes('GLMPS'));
});

test('Electron appended after the app name instead of after Chrome is still stripped', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Electron/44.4.5 GLMPS2/0.1.0 Chrome/140.0.7339.0 Safari/537.36';
  assert.equal(chromeUserAgent(ua), PLAIN_CHROME_UA);
});

test('an already-plain Chrome user agent passes through unchanged', () => {
  assert.equal(chromeUserAgent(PLAIN_CHROME_UA), PLAIN_CHROME_UA);
});

test('a string that does not look like a Chromium user agent is returned unchanged rather than mangled', () => {
  assert.equal(chromeUserAgent('not a user agent'), 'not a user agent');
  assert.equal(chromeUserAgent(''), '');
});
