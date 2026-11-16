// apps/shell/src/lib/screen-share.js
// Pure decision logic behind the slack-only setDisplayMediaRequestHandler in
// shell-window.js: which requester may ask to share a screen, and how the
// operator's choice in the picker page maps onto the callback shape
// electron-44.4.5/api/session.md's `ses.setDisplayMediaRequestHandler`
// expects (`{ video: { id, name } }`, optionally `audio: 'loopback'`, or
// `null` to deny this one request - distinct from passing `null` as the
// whole handler, which resets it).
import { isSlackOrigin } from './navigation.js';

// The handler is only ever installed on the slack partition's session
// (shell-window.js), so in practice every request already comes from a Slack
// document; this check is the same defence-in-depth every other sender-facing
// decision in this app applies (fromSplitter, fromOffline, permissions.js's
// own origin-scoped media/display-capture grant) rather than trusting
// partition scoping alone.
export function mayRequestDisplayMedia({ securityOrigin }) {
  return isSlackOrigin(securityOrigin);
}

// desktopCapturer.getSources is async, so a second getDisplayMedia request
// can arrive while the first is still loading sources - before the picker
// has even shown. The slot (shell-window.js's `pendingPicker`) is claimed
// synchronously, before that await, specifically so this sees it occupied:
// `null`/`undefined` means idle, anything else (a `{ loading: true }`
// placeholder, or the full `{ sources, resolve, requestId }` once open) means
// a request already owns it.
export function mayClaimScreenShareSlot(slot) {
  return slot === null || slot === undefined;
}

// 2026-10-02 (re-review): getSources can take up to the caller's own timeout
// to answer, so a request is "loading" for a while before the picker is ever
// shown. Shortcuts (shortcutsSuspended in shell-window.js) must only be
// suspended once the picker is actually in front of the operator - true only
// once the slot carries the resolver showPicker's promise is waiting on.
export function isScreenShareShowing(slot) {
  return Boolean(slot?.resolve);
}

// A slot marked `closed` (the window closed while its sources were still
// loading) must make a getSources resolution that lands afterwards answer
// callback(null) and never call showPicker on a window that is gone.
export function isScreenShareAbandoned(slot) {
  return Boolean(slot?.closed);
}

// Races a promise against a plain timer so a hung desktopCapturer.getSources
// lookup cannot leave the screen-share slot claimed forever: rejects with
// `message` once `ms` elapses without `promise` having settled. No Electron
// or timer dependency beyond the global setTimeout/clearTimeout, so it is
// exercised directly in apps/shell/test with real (short) delays.
export function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Looping system audio back into a huddle plays it back to every other
// participant too, so it is only ever offered when the web content actually
// asked for an audio stream (`request.audioRequested`, session.md), and only
// where Electron documents loopback support (session.md: `audio: 'loopback'`
// "is currently only supported on Windows").
export function offerSystemAudio({ platform, audioRequested }) {
  return platform === 'win32' && Boolean(audioRequested);
}

// `includeAudio` requests Windows' system-audio loopback (session.md: a
// string `audio` of 'loopback' captures system audio and "is currently only
// supported on Windows"; this shell only ships for Windows). Plain
// 'loopback', not 'loopbackWithMute': the point is to carry the shared
// screen's sound into the huddle, not to silence it for the presenter.
export function displayMediaCallbackArgs({ sourceId, sources, includeAudio }) {
  if (!sourceId) return null;
  const source = Array.isArray(sources) ? sources.find((s) => s.id === sourceId) : undefined;
  if (!source) return null; // an id the picker never offered: deny rather than guess
  const args = { video: { id: source.id, name: source.name } };
  if (includeAudio) args.audio = 'loopback';
  return args;
}
