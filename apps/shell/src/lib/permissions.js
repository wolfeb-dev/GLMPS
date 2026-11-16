import { isSlackOrigin } from './navigation.js';

// One allow-list per session. Used for both setPermissionRequestHandler and
// setPermissionCheckHandler (electron-44.4.5/api/session.md: both are needed,
// and a notifications check arrives with webContents === null, so the
// decision is keyed by the session's role, never by the requesting page).
// A Map (not a plain object) keyed by role: a plain object lookup on a role
// string that shadows Object.prototype ('__proto__', 'constructor',
// 'toString', ...) resolves to an inherited value instead of undefined and
// throws when `.includes`/`.has` is called on it. A Map's key lookup is
// unaffected by the prototype chain, so an unknown or prototype-shadowing
// role simply misses and fails closed to false.
// 2026-10-02 (card glmps-2-0-14, operator decision): the Slack pane must carry
// huddles (microphone, camera, screen share), reversing Phase S's call 4
// ("Slack media denied"). `media` and `display-capture` join the slack-only
// list; the dashboard and local roles are unchanged.
// 2026-10-27 (card glmps-2-0-runtime-82): the dashboard's huddle needs the
// microphone, so the dashboard role gets `media` too, narrowed below to
// audio only and to the dashboard's own origin.
const ALLOW = new Map([
  ['slack', Object.freeze(['notifications', 'clipboard-sanitized-write', 'fullscreen', 'media', 'display-capture'])],
  ['dashboard', Object.freeze(['clipboard-sanitized-write', 'fullscreen', 'media'])],
  ['local', Object.freeze([])],
]);

// What a `media` request/check may ask for. Chromium's `media` permission
// covers camera, microphone and speaker access together (session.md); a
// huddle only ever needs audio and video, so anything else named in
// mediaTypes (and an unrecognised mediaType, which the check handler reports
// as the literal string 'unknown') is refused even for Slack.
const ALLOWED_MEDIA_TYPES = new Set(['audio', 'video']);

// 2026-10-02 (PR #29 review): a slack-role *session* can still host a
// cross-origin *frame* - an embedded third-party widget or ad - and that
// frame's own origin is who the request/check is actually naming, not the
// top-level Slack page. media and display-capture are the two permissions
// that reach real hardware (camera, microphone, the whole screen), so for
// those two the grant is scoped to the requesting origin itself, in addition
// to the role allow-list above; an absent or unparseable origin fails closed,
// the same posture as an unknown role.
export const ORIGIN_SCOPED = new Set(['media', 'display-capture']);

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

// The dashboard's grant is a microphone and nothing else: every mediaType
// must be 'audio' and at least one must be named, so a check that names no
// media type (or 'unknown') fails closed rather than inheriting Slack's
// audio-and-video rule. dashboardOrigin is the configured kernel URL's origin;
// a page from anywhere else in the dashboard partition gets nothing.
function dashboardMedia({ mediaTypes, origin, dashboardOrigin }) {
  const want = originOf(dashboardOrigin);
  if (!want || want === 'null' || originOf(origin) !== want) return false;
  return Array.isArray(mediaTypes) && mediaTypes.length > 0 && mediaTypes.every((t) => t === 'audio');
}

export function permissionDecision({ role, permission, mediaTypes, origin, dashboardOrigin }) {
  const allowed = ALLOW.get(role);
  if (!allowed || !allowed.includes(permission)) return false;
  if (role === 'dashboard' && permission === 'media') return dashboardMedia({ mediaTypes, origin, dashboardOrigin });
  if (role === 'slack' && ORIGIN_SCOPED.has(permission) && !isSlackOrigin(origin)) return false;
  if (permission === 'media' && Array.isArray(mediaTypes)) {
    return mediaTypes.every((t) => ALLOWED_MEDIA_TYPES.has(t));
  }
  return true;
}
