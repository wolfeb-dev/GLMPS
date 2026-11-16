// server/lib/index-store.js
import fs from 'node:fs';
import path from 'node:path';

// Real Claude Code transcripts carry `timestamp` as an ISO-8601 STRING, and
// extract-claude.js passes it through verbatim as `e.ts`, so the agent counter
// below was doing a string-vs-number relational compare ('2026-...' > 0), which
// coerces to NaN and is ALWAYS false: every agentsUsed row kept lastTs 0 against
// real data, and /api/agents reported lastUsed 0 for every agent (rendered as
// 1970 + "stale" in the Capability Registry). server.js:621 already normalises
// the same field the same way for the events feed. Returns null - never 0 - for
// anything unparseable, so "no usable timestamp" stays distinguishable from
// "the epoch".
function epochMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') { const n = Date.parse(v); return Number.isFinite(n) ? n : null; }
  return null;
}

// OpenCode rows written before card glmps-2-0-runtime-132 keyed the session by
// `<public id>|@dir@|<local messages dir>`, which put a filesystem path into
// /api/state and split one session into two once the public id took over.
const LEGACY_DIR_SEP = '|@dir@|';

export class IndexStore {
  constructor(file) {
    this.file = file;
    this.records = new Map();
    let migrated = false;
    try {
      const arr = JSON.parse(fs.readFileSync(file, 'utf-8'));
      for (const r of arr) {
        // Repair state already on disk, not just new writes: a record whose
        // lastTs was persisted as an ISO string would otherwise stay invisible
        // to sinceTs filtering forever, since the fix below only covers the
        // write path.
        if (typeof r?.lastTs === 'string') {
          const n = epochMs(r.lastTs);
          if (n !== null) r.lastTs = n;
        }
        if (typeof r?.id === 'string' && r.id.includes(LEGACY_DIR_SEP)) {
          migrated = true;
          r.id = r.id.slice(0, r.id.indexOf(LEGACY_DIR_SEP));
        }
        // Only a migrated row can collide; the newer of the pair wins.
        const other = this.records.get(r?.id);
        if (other && (other.lastTs ?? 0) >= (r.lastTs ?? 0)) continue;
        this.records.set(r.id, r);
      }
    } catch {}
    this._dirty = migrated;
  }

  get(id) { return this.records.get(id); }

  upsert(id, fields) {
    const rec = this.records.get(id) ?? { id, skillsUsed: [], agentsUsed: [], eventCount: 0 };
    Object.assign(rec, fields);
    // One normalisation rule for every writer. lastTs is compared numerically
    // by list() (both the sinceTs filter and the sort), so a string here is a
    // silent NaN in both.
    if (typeof rec.lastTs === 'string') {
      const n = epochMs(rec.lastTs);
      if (n !== null) rec.lastTs = n;
    }
    this.records.set(id, rec);
    this._dirty = true;
    return rec;
  }

  applyEvents(id, events) {
    const rec = this.upsert(id, {});
    if (!Array.isArray(rec.agentsUsed)) rec.agentsUsed = [];
    for (const e of events) {
      rec.eventCount += 1;
      // glmps-47: e.ts is an ISO-8601 STRING for every Claude Code
      // session (extract-claude.js passes the transcript's timestamp through
      // verbatim). Assigning it raw put a string into a field list() compares
      // numerically. epochMs returns null - never 0 - for anything
      // unparseable, so a junk timestamp keeps the previous value instead of
      // stamping the epoch on the record.
      rec.lastTs = epochMs(e.ts) ?? rec.lastTs;
      if (e.kind === 'skill' && e.label && !rec.skillsUsed.includes(e.label))
        rec.skillsUsed.push(e.label);
      if (e.kind === 'agent' && e.agent) {
        const model = e.model ?? null;
        let row = rec.agentsUsed.find(a => a.name === e.agent && a.model === model);
        if (!row) { row = { name: e.agent, model, count: 0, lastTs: 0 }; rec.agentsUsed.push(row); }
        row.count += 1;
        const t = epochMs(e.ts);
        if (t !== null && t > row.lastTs) row.lastTs = t;
      }
      if (!rec.title && e.kind === 'tool' && /^User: /.test(e.label ?? ''))
        rec.title = e.label.slice(6, 126);
    }
    this._dirty = true;
  }

  list(filter = {}) {
    let out = [...this.records.values()];
    if (filter.tool) out = out.filter(r => r.tool === filter.tool);
    if (filter.cwd) out = out.filter(r => r.cwd === filter.cwd);
    if (filter.skill) out = out.filter(r => (r.skillsUsed ?? []).includes(filter.skill));
    if (filter.sinceTs) out = out.filter(r => (r.lastTs ?? 0) >= filter.sinceTs);
    return out.sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));
  }

  flush() {
    if (!this._dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...this.records.values()]));
    fs.renameSync(tmp, this.file);
    this._dirty = false;
  }
}
