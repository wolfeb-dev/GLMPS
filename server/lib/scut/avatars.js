// server/lib/scut/avatars.js
// Where an agent's Slack profile picture lives. Pure string work, no I/O, so
// the theme can stay pure and the settings layer has exactly one place that
// decides whether a base URL is usable.
//
// The constraint that shapes this module: Slack fetches `icon_url` from SLACK's
// servers, not from the operator's browser. GLMPS binds to 127.0.0.1
// by design, so it can never serve its own avatars - a loopback URL would
// resolve inside Slack's infrastructure. The images have to sit on a public
// https host, and this module refuses anything else rather than letting a
// silently-broken URL reach chat.postMessage.

/** The two theme modes, and the two directories an avatar set is laid out in. */
export const AVATAR_MODES = ['pro', 'bob'];

// A slug is a filename component, so keep it to the same shape as an agent id.
// This is what stops a renamed agent (or a hostile one) from walking the path.
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Normalize an avatar base URL, or return null when it is unusable.
 * Unusable means: absent, not a string, unparseable, or not https.
 * Trailing slashes are stripped so `.../scut` and `.../scut/` behave alike.
 */
export function normalizeAvatarBase(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  return raw.replace(/\/+$/, '');
}

/**
 * Compose the avatar URL for one agent in one mode: `<base>/<mode>/<slug>.png`.
 * Returns null when the base is unconfigured/unusable, the mode is unknown, or
 * the slug is not a plain filename - never a half-formed URL.
 */
export function avatarUrl(base, mode, slug) {
  const b = normalizeAvatarBase(base);
  if (!b) return null;
  if (!AVATAR_MODES.includes(mode)) return null;
  const s = typeof slug === 'string' ? slug.trim() : '';
  if (!SLUG.test(s)) return null;
  return `${b}/${mode}/${s}.png`;
}
