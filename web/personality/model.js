// web/personality/model.js
// The Personality page's filter logic and number formats. Pure: no DOM, so it
// is importable under node:test.

export const DEFAULT_FILTERS = Object.freeze({ ai: 'all', shape: 'all', q: '' });

function haystack(c) {
  const rows = Array.isArray(c.rows) ? c.rows.map((r) => `${r.name} ${r.description ?? ''} ${r.personality ?? ''} ${r.path ?? ''}`).join(' ') : '';
  return `${c.name} ${c.controls ?? ''} ${c.path ?? ''} ${c.text ?? ''} ${c.searchText ?? ''} ${(c.usedBy ?? []).join(' ')} ${(c.usedByGraphs ?? []).join(' ')} ${rows}`.toLowerCase();
}

export function cardMatches(c, f) {
  if (f.ai !== 'all' && !(c.readBy ?? []).includes(f.ai)) return false;
  if (f.shape !== 'all' && !(c.shapes ?? []).includes(f.shape)) return false;
  const q = String(f.q ?? '').trim().toLowerCase();
  return !q || haystack(c).includes(q);
}

export function filterGroups(data, f) {
  return (data?.groups ?? []).map((g) => {
    const cards = (g.cards ?? []).filter((c) => cardMatches(c, f));
    return { ...g, cards, empty: cards.length === 0 };
  });
}

export function fmtSize(n) {
  if (!Number.isFinite(n)) return '-';
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

export function relTime(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return '-';
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
