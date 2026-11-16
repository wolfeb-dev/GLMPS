// web/surface/records.js
// The detail an old Now link carried (sel=loop:<name>, sel=alert:<id>), shown
// in Surface's inspector now that Now is retired (glmps-2-0-63). Both are
// read-only except Run now, which asks the server to queue a timed loop.
import { resolveTarget } from '../shared/deep-link.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const iso = (ts) => new Date(ts).toISOString();

export async function openLoopRecord(api, name) {
  try {
    const res = await fetch(`/api/loops/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`GET /api/loops/${name} returned ${res.status}`);
    const rec = await res.json();
    if (api.destroyed) return;
    const actions = [];
    if (rec.trigger?.everyMs) { // event and external loops answer 409; do not offer what cannot run
      const run = el('button', 'att-btn', 'Run now'); run.type = 'button';
      run.addEventListener('click', async () => {
        try {
          const r = await fetch(`/api/loops/${encodeURIComponent(name)}/run`, { method: 'POST' });
          api.ctx.toast(r.status === 202 ? `Run of ${name} queued` : `Run of ${name} refused (${r.status})`);
        } catch (e) {
          console.error(`run of ${name} failed`, e);
          api.ctx.toast(`Run of ${name} failed: ${e?.message ?? e}`);
        }
      });
      actions.push(run);
    }
    api.inspect({
      title: name,
      facts: [
        ['last outcome', rec.lastOutcome], ['reason', rec.lastReason ?? 'none'], ['consecutive failures', rec.consecutiveFailures],
        ['streak started', rec.streakStartTs ? iso(rec.streakStartTs) : 'no streak'], ['next run', rec.nextRunTs ? iso(rec.nextRunTs) : 'not scheduled'],
        ...(rec.recentFailures ?? []).slice(0, 5).map((f) => ['failure', `${iso(f.ts)}  ${f.reason}`]),
      ],
      actions,
    });
  } catch (e) {
    console.error(`the ${name} loop record failed`, e);
    if (!api.destroyed) api.inspect({ title: name, empty: `The ${name} loop record failed to load: ${e?.message ?? e}` });
  }
}

// An alert in the loaded feed; false when it is not there (the caller says so).
export function openAlertRecord(api, id) {
  const alerts = api.data.alerts?.ok ? api.data.alerts.data?.alerts ?? [] : [];
  const a = alerts.find((x) => String(x.id) === String(id));
  if (!a) return false;
  const actions = [];
  if (a.target) {
    const go = el('a', 'att-btn', 'Go to source');
    go.href = resolveTarget(a.target);
    go.addEventListener('click', (e) => { if (e.ctrlKey || e.metaKey) return; e.preventDefault(); api.ctx.go(go.href); });
    actions.push(go);
  }
  api.inspect({
    title: a.title,
    word: a.detail || undefined,
    facts: [['severity', a.severity], ['source', a.source], ['raised', Number.isFinite(a.ts) ? iso(a.ts < 1e12 ? a.ts * 1000 : a.ts) : null]],
    actions,
  });
  return true;
}
