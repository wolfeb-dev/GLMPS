// server/lib/scut/avatar-check.js
// Does the avatar set actually exist at the URL SCUT has been pointed at?
//
// Publishing the pictures is the one manual step in this feature, and without
// this the operator's next signal is a Slack message that either does or does
// not have a picture on it - with no way to tell a wrong URL from a private
// repo from Slack's own image cache. This asks the question directly.
//
// fetch is injected so the whole thing is unit-testable with no network.
import { normalizeAvatarBase, AVATAR_MODES } from './avatars.js';
import { AGENT_IDS, SCUT_AVATAR_SLUG } from './bobiverse.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Every relative path that must be reachable under the avatar base URL. */
export function expectedAvatarPaths() {
  const slugs = [...AGENT_IDS, SCUT_AVATAR_SLUG];
  const paths = [];
  for (const mode of AVATAR_MODES) for (const slug of slugs) paths.push(`${mode}/${slug}.png`);
  paths.push('app-icon.png');
  return paths;
}

function looksLikePng(bytes) {
  if (!bytes || bytes.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

/**
 * Fetch every expected avatar under `base` and report what came back.
 *
 * Deliberately a GET that reads the body, not a HEAD that reads the status: the
 * most common failure is a host answering 200 with an HTML sign-in page, which a
 * status-only probe calls a pass. The files are 12-26KB, so reading them costs
 * nothing and buys certainty that the bytes are a real image.
 *
 * Never throws. A transport failure is recorded against the path that hit it.
 *
 * @param {string|null} base
 * @param {{fetchImpl?: typeof fetch, concurrency?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<{base:string|null, ok:boolean, results:Array<object>}>}
 */
export async function checkAvatarBase(base, { fetchImpl = fetch, concurrency = 6, timeoutMs = 15000 } = {}) {
  const normalized = normalizeAvatarBase(base);
  // Nothing is worth requesting against a URL Slack itself would refuse.
  if (!normalized) return { base: null, ok: false, results: [] };

  const paths = expectedAvatarPaths();
  const results = new Array(paths.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= paths.length) return;
      const path = paths[i];
      const url = `${normalized}/${path}`;
      try {
        const res = await fetchImpl(url, {
          redirect: 'follow',
          // AbortSignal.timeout exists on every Node this repo supports, but a
          // test's fake fetch ignores the init object entirely, so this is
          // belt-only: a hung real host, not a hung fake one.
          signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
        });
        const status = res.status ?? 0;
        let bytes = null;
        try { bytes = new Uint8Array(await res.arrayBuffer()); } catch { bytes = null; }
        const isPng = looksLikePng(bytes);
        results[i] = {
          path,
          url,
          status,
          isPng,
          bytes: bytes ? bytes.length : 0,
          contentType: res.headers?.get?.('content-type') ?? null,
          ok: status >= 200 && status < 300 && isPng,
          error: null,
        };
      } catch (e) {
        results[i] = { path, url, status: 0, isPng: false, bytes: 0, contentType: null, ok: false, error: String(e?.message ?? e) };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, paths.length)) }, worker));
  return { base: normalized, ok: results.every((r) => r.ok), results };
}

/**
 * Turn a report into guidance an operator can act on. Every line names a cause
 * and its fix; a clean report produces nothing, because a green run should be
 * one line of output, not a lecture.
 */
export function diagnose(report) {
  if (report?.ok) return [];
  const lines = [];

  if (!report?.base) {
    lines.push('The base URL was refused before anything was requested: it must be a public https:// URL.');
    lines.push('Slack fetches the picture from ITS servers, so http://, file:// and 127.0.0.1 can never work.');
    return lines;
  }

  const results = report.results ?? [];
  const missing = results.filter((r) => r.status === 404);
  const notImage = results.filter((r) => r.status >= 200 && r.status < 300 && !r.isPng);
  const unreachable = results.filter((r) => r.error);
  const denied = results.filter((r) => r.status === 401 || r.status === 403);

  if (unreachable.length) {
    lines.push(`${unreachable.length} request(s) never completed (e.g. ${unreachable[0].error}). Check the host name.`);
  }
  if (denied.length) {
    lines.push(`${denied.length} file(s) returned ${denied[0].status}. The host is asking for credentials; Slack has none. The files must be readable anonymously.`);
  }
  if (missing.length) {
    lines.push(`${missing.length} of ${results.length} file(s) returned 404. The usual causes, in the order they happen:`);
    lines.push('  - the repository is private. Make it public: a private repo\'s raw URL 404s for anyone not signed in, Slack included.');
    lines.push('  - the branch in the URL is wrong. Use the branch you actually pushed to (main vs master).');
    lines.push('  - the base points at the repo root. It must point at the folder that CONTAINS pro/ and bob/.');
    if (missing[0].url) lines.push(`  - the files were never pushed. Open this in a browser: ${missing[0].url}`);
  }
  if (notImage.length) {
    lines.push(`${notImage.length} file(s) answered 200 but did not return an image.`);
    lines.push('  - a github.com/<owner>/<repo>/blob/... URL serves a WEB PAGE. Use raw.githubusercontent.com/<owner>/<repo>/<branch>/... instead.');
    lines.push('  - a host that answers every path with a sign-in page looks like this too.');
  }
  return lines;
}

/** Why one file is unusable, in as few words as carry the fix. */
function reasonFor(r) {
  if (r.error) return r.error;
  if (r.status < 200 || r.status >= 300) return `HTTP ${r.status}`;
  return `HTTP ${r.status} but not an image (${r.bytes} bytes, ${r.contentType ?? 'no content-type'})`;
}

/**
 * Render a report for a terminal. Lives here rather than in the CLI so the
 * success path - the one a maintainer can least easily reproduce by hand - is
 * covered by a unit test like everything else.
 *
 * @param {object} report - from checkAvatarBase
 * @param {{configured?: string|null, requested?: string|null, settingsFile?: string, docPath?: string}} ctx
 * @returns {{lines: string[], exitCode: number}}
 */
export function formatReport(report, { configured = null, requested = null, settingsFile = '<settings file>', docPath = 'docs/scut-profile-pictures.md' } = {}) {
  const lines = [];
  const total = report.results?.length || expectedAvatarPaths().length;

  if (report.ok) {
    const kb = Math.round(report.results.reduce((n, r) => n + r.bytes, 0) / 1024);
    lines.push(`All ${report.results.length} files are published and readable (${kb} KB total).`);
    lines.push('');
    if (requested && requested !== configured) {
      lines.push('Turn the pictures on with either of these:');
      lines.push('');
      lines.push(`  SCUT_AVATAR_BASE_URL=${report.base}`);
      lines.push(`  or set "avatarBaseUrl": "${report.base}" in ${settingsFile}`);
      lines.push('');
      lines.push('No restart needed - the next message SCUT posts uses them.');
    } else {
      lines.push('SCUT is pointed here already. The next message it posts uses these pictures.');
    }
    return { lines, exitCode: 0 };
  }

  const failed = (report.results ?? []).filter((r) => !r.ok);
  lines.push(`${failed.length || total} of ${total} file(s) are not usable:`);
  lines.push('');
  for (const r of failed.slice(0, 5)) lines.push(`  ${r.path.padEnd(20)} ${reasonFor(r)}`);
  if (failed.length > 5) lines.push(`  ... and ${failed.length - 5} more`);
  lines.push('');
  for (const line of diagnose(report)) lines.push(line);
  lines.push('');
  lines.push(`Walkthrough: ${docPath}`);
  return { lines, exitCode: 1 };
}
