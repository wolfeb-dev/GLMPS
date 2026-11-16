// web/surface/format.js
// Small formatters shared by the panels, the hover card and the edits window.
import { formatTime } from '../shared/time-format.js';
export const basename = (p) => String(p ?? '').split(/[/\\]/).filter(Boolean).pop() ?? '';
export const normPath = (p) => String(p ?? '').replace(/\\/g, '/');

export function since(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function bytes(n) {
  if (!Number.isFinite(n)) return 'unknown';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export const stamp = (ts) => (Number.isFinite(ts) ? formatTime(ts) : 'unknown');
