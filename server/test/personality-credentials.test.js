// server/test/personality-credentials.test.js
// AC-4: credential and token files are listed by name only. The deny list is a
// pure decision on the path, made before anything is stat-ed or read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isWithheld } from '../lib/personality/credentials.js';

const gem = path.join(path.sep, 'h', '.gemini');

test('name patterns are withheld wherever they sit', () => {
  for (const name of ['.env', '.env.local', 'my-token.txt', 'API_TOKEN.md', 'client_secret.json', 'secrets.yml', 'server.key', 'cert.PEM', 'credentials.json', 'credentials-old.json']) {
    assert.equal(isWithheld(path.join(path.sep, 'repo', name), { geminiDir: gem }), true, name);
  }
});

test('ordinary instruction files are not withheld', () => {
  for (const name of ['CLAUDE.md', 'settings.json', 'roster.js', 'chair.md', 'keyboard.md']) {
    assert.equal(isWithheld(path.join(path.sep, 'repo', name), { geminiDir: gem }), false, name);
  }
});

test('gemini oauth and account files are withheld by name', () => {
  for (const name of ['oauth_creds.json', 'google_accounts.json', 'oauth-state.json']) {
    assert.equal(isWithheld(path.join(gem, name), { geminiDir: gem }), true, name);
  }
});

test('under ~/.gemini only settings.json, config/config.json and skills are readable', () => {
  assert.equal(isWithheld(path.join(gem, 'settings.json'), { geminiDir: gem }), false);
  assert.equal(isWithheld(path.join(gem, 'config', 'config.json'), { geminiDir: gem }), false);
  assert.equal(isWithheld(path.join(gem, 'config', 'skills', 'x', 'SKILL.md'), { geminiDir: gem }), false);
  assert.equal(isWithheld(path.join(gem, 'antigravity', 'skills', 'x', 'SKILL.md'), { geminiDir: gem }), false);
  assert.equal(isWithheld(path.join(gem, 'projects.json'), { geminiDir: gem }), true);
  assert.equal(isWithheld(path.join(gem, 'antigravity', 'conversations', 'a.db'), { geminiDir: gem }), true);
  assert.equal(isWithheld(path.join(gem, 'config', 'state.json'), { geminiDir: gem }), true);
});

test('a path that only resembles the gemini dir is not caught by the gemini rule', () => {
  assert.equal(isWithheld(path.join(path.sep, 'h', '.gemini-notes', 'a.md'), { geminiDir: gem }), false);
});
