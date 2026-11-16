import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { publicScanPatterns, publicScanHits, HISTORY_PATTERNS, shipTextPatterns, personalAccountNames, projectNames, buildingProjectNames, buildingPrivateNames } from '../lib/governance/private-text-scan.js';
import os from 'node:os';
import * as builder from '../../scripts/release-builder.mjs';

test('the scanner finds drive paths, home paths, .gemini dirs and a private name', () => {
  const text = 'see C:\\Users\\zed\\notes and /home/zed/x and .gemini/brain/a plus zed here';
  const hits = publicScanHits(text, publicScanPatterns(['zed']));
  assert.deepEqual(hits.map((h) => h.pattern).sort(), ['.gemini dir', 'drive path', 'home path', 'name zed']);
});

test('a name under 3 characters is skipped, as the release scan does', () => {
  assert.deepEqual(publicScanHits('al is here', publicScanPatterns(['al'])), []);
});

test('HISTORY_PATTERNS names a ticket id and a memory block', () => {
  const hits = publicScanHits('fixed in glmps-2-0-193 and mc-12', HISTORY_PATTERNS);
  assert.deepEqual(hits.map((h) => h.match), ['glmps-2-0-193', 'mc-12']);
  assert.equal(publicScanHits('## Cross-Agent Memory', HISTORY_PATTERNS)[0].pattern, 'memory block');
});

test('the release builder re-exports the very same scanner', () => {
  assert.equal(builder.publicScanPatterns, publicScanPatterns);
  assert.equal(builder.publicScanHits, publicScanHits);
  assert.equal(builder.HISTORY_PATTERNS, HISTORY_PATTERNS);
});

test('the scanner module imports nothing from scripts/', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'governance', 'private-text-scan.js'), 'utf8');
  assert.doesNotMatch(src, /from\s+['"][^'"]*scripts\//);
});

test('a Windows built-in service account is not a private name', () => {
  const text = 'the system prompt, a local service, a network service and HOST$ here';
  for (const n of ['SYSTEM', 'LOCAL SERVICE', 'NETWORK SERVICE', 'HOST$', 'system']) {
    assert.deepEqual(publicScanHits(text, publicScanPatterns([n])), [], n);
  }
  assert.equal(publicScanHits('zed and the system', publicScanPatterns(['SYSTEM', 'zed']))[0].pattern, 'name zed');
});

test('personalAccountNames drops built-in service accounts and reads the user folder from a path', () => {
  assert.deepEqual(personalAccountNames({ username: 'SYSTEM', paths: ['C:\\Windows\\system32\\config\\systemprofile'] }), []);
  assert.deepEqual(personalAccountNames({ username: 'SYSTEM', paths: ['C:\\Users\\zed\\.glmps2'] }), ['zed']);
  assert.deepEqual(personalAccountNames({ username: 'zed', paths: ['/home/zed/.glmps2', '/Users/Zed/x'] }), ['zed']);
  for (const n of ['root', 'Administrator', 'runner', 'LOCAL SERVICE', 'HOST$']) assert.deepEqual(personalAccountNames({ username: n }), []);
});

test('under the service account the word system is not a private name', () => {
  const names = personalAccountNames({ username: 'SYSTEM' });
  assert.deepEqual(publicScanHits('The system restarts the loop.', shipTextPatterns(names)), []);
});

test('shipTextPatterns is the public scan plus dev history', () => {
  const hits = publicScanHits('zed in D:/x/y and glmps-2-0-84', shipTextPatterns(['zed']));
  assert.deepEqual(hits.map((h) => h.pattern).sort(), ['drive path', 'name zed', 'ticket id']);
});

// card glmps-2-0-220: the maintainer's other projects never reach a public build.
test('projectNames: board projects and repo folder names, minus the product and short names', () => {
  const names = projectNames({
    projects: ['Acme-App', 'glmps-2.0', 'acme-app', 'glmps', 'default', 'ab', null],
    dirs: ['D:\\Northwind Portal', 'D:/glmps_prod', 'C:/Users/x/.glmps2/runner/worktrees/glmps-2.0/glmps-2-0-9', '/home/x/scut-build.old/', 7],
  });
  assert.deepEqual(names, ['Acme-App', 'Northwind Portal']);
});

test('buildingProjectNames reads the board and the settings, and fails open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-projnames-'));
  try {
    const settings = path.join(dir, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ permissions: { additionalDirectories: ['D:/Acme-App'] } }));
    const loadBoard = () => ({ items: [{ project: 'Garden' }, { project: 'glmps-2.0' }] });
    assert.deepEqual(buildingProjectNames({ stateDir: dir, claudeSettingsFile: settings, loadBoard }).sort(), ['Acme-App', 'Garden']);
    fs.writeFileSync(settings, '{nope');
    assert.deepEqual(buildingProjectNames({ claudeSettingsFile: settings, loadBoard: () => { throw new Error('x'); } }), []);
    assert.deepEqual(buildingProjectNames(), []);
    const all = buildingPrivateNames({ stateDir: dir, claudeSettingsFile: null, loadBoard });
    assert.ok(all.includes('Garden'));
    const hits = publicScanHits('see garden for details', publicScanPatterns(all));
    assert.deepEqual(hits.map((h) => h.match), ['garden']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// card glmps-2-0-225: a project named only in the Slack settings is still private.
test('buildingProjectNames reads the Slack settings projects, and fails open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-projnames-scut-'));
  try {
    const scut = path.join(dir, 'scut-settings.json');
    fs.writeFileSync(scut, JSON.stringify({ projectSystems: { 'Acme-App': 'vega', 'glmps-2.0': 'sol' }, defaultProjects: ['Vault', 'acme-app'] }));
    assert.deepEqual(buildingProjectNames({ stateDir: dir }).sort(), ['Acme-App', 'Vault']);
    const hits = publicScanHits('see vault for details', publicScanPatterns(buildingPrivateNames({ stateDir: dir })));
    assert.deepEqual(hits.map((h) => h.match), ['vault']);
    fs.writeFileSync(scut, '{nope');
    assert.deepEqual(buildingProjectNames({ stateDir: dir }), []);
    fs.writeFileSync(scut, JSON.stringify({ projectSystems: ['x'], defaultProjects: 'Vault' }));
    assert.deepEqual(buildingProjectNames({ stateDir: dir }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
