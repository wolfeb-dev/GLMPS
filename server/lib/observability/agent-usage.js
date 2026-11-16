// server/lib/observability/agent-usage.js
// Pure: fold persisted per-session agentsUsed rows into one usage row per
// agent. Reads only what IndexStore wrote; invents nothing when a session
// predates agent capture (its records simply have no agentsUsed key).

const MODEL_BUCKETS = ['sonnet', 'haiku', 'opus'];

function emptySplit() { return { sonnet: 0, haiku: 0, opus: 0, none: 0 }; }

/**
 * @param {Array<{ agentsUsed?: Array<{name,model,count,lastTs}> }>} records
 * @returns {Map<string, { dispatches:number, modelSplit:object, lastUsed:number|null }>}
 */
export function aggregateAgentUsage(records = []) {
  const out = new Map();
  for (const rec of records) {
    const rows = Array.isArray(rec?.agentsUsed) ? rec.agentsUsed : [];
    for (const r of rows) {
      if (!r?.name) continue;
      const key = String(r.name).toLowerCase();
      let acc = out.get(key);
      if (!acc) { acc = { dispatches: 0, modelSplit: emptySplit(), lastUsed: null }; out.set(key, acc); }
      const n = Number(r.count) || 0;
      acc.dispatches += n;
      const bucket = MODEL_BUCKETS.includes(r.model) ? r.model : 'none';
      acc.modelSplit[bucket] += n;
      if (r.lastTs != null && (acc.lastUsed == null || r.lastTs > acc.lastUsed)) acc.lastUsed = r.lastTs;
    }
  }
  return out;
}
