// server/test/wiki-sandbox-headers.test.js
// a repo-supplied wiki page opened top-level ran script on the kernel's
// own origin. CSP sandbox makes it an opaque origin wherever it is opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-wikisb-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  const projectDir = path.join(tmp, 'repo-x'); fs.mkdirSync(path.join(projectDir, 'graphify-out', 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: [projectDir.replace(/\\/g, '/')] } }));
  return { tmp, projectDir, env: { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gt'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vs'), GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy'),
    GLMPS_CODEX_DIR: path.join(tmp, 'cx'), GLMPS_HERMES_DIR: path.join(tmp, 'hm'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_OPENCODE_DIR: path.join(tmp, 'oc'), GLMPS_UNMERGED_SCAN: 'off' } };
}

test('F11: /wiki-ext pages carry CSP sandbox allow-scripts and nosniff', async () => {
  const { projectDir, env } = mkEnv();
  fs.writeFileSync(path.join(projectDir, 'graphify-out', 'wiki', 'core.html'), '<script>fetch("/api/backlog",{method:"POST"})</script>');
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/wiki-ext/repo-x/core.html`);
    assert.equal(r.status, 200);
    const csp = r.headers.get('content-security-policy').split(';').map((d) => d.trim());
    assert.equal(csp[0], 'sandbox allow-scripts');
    // Scan 2026-10-15 F5: the page cannot send its own URL (and wiki ticket) anywhere.
    for (const d of ["connect-src 'none'", "form-action 'none'", 'img-src data: blob:', "frame-src 'none'", "object-src 'none'"]) assert.ok(csp.includes(d), d);
    assert.ok(!csp.some((d) => /^(default|script|style)-src/.test(d)), 'its own scripts and stylesheet still load');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  } finally { await srv.close(); }
});

test('F11: a wiki page that is a symlink to a file outside the wiki dir is not served', async (t) => {
  const { tmp, projectDir, env } = mkEnv();
  const secret = path.join(tmp, 'outside-secret.html');
  fs.writeFileSync(secret, 'OUTSIDE_SECRET');
  try { fs.symlinkSync(secret, path.join(projectDir, 'graphify-out', 'wiki', 'evil.html'), 'file'); }
  catch (e) { t.skip(`cannot create a file symlink here (${e.code})`); return; }
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/wiki-ext/repo-x/evil.html`);
    assert.equal(r.status, 404);
    assert.doesNotMatch(await r.text(), /OUTSIDE_SECRET/);
  } finally { await srv.close(); }
});
