// scripts/lib/huddle-bench-stats.mjs
// Pure scoring helpers for scripts/huddle-bench.mjs, kept separate so they can
// be unit tested without starting any model. The bar is the one written before
// the first run (spec section 9) and must not change after a measurement.
export const BAR = Object.freeze({ nameMs: 1500, leadMs: 2500, floorOk: 8, floorOf: 10 });

// A call that threw, or resolved with no text, is a failure, never a fast pass.
export function classifyCall(res, err = null) {
  if (err) return { failed: true, error: String(err.message ?? err) };
  if (!res || !String(res.text ?? '').trim()) return { failed: true, error: 'empty reply' };
  return { failed: false, error: null };
}

// Error text is written to a committed report: never let the key into it.
export function scrub(message, secret) {
  const s = String(message ?? '');
  return secret ? s.split(secret).join('[redacted]') : s;
}

export function isColdRow({ floorCold = false, mindCold = false }) {
  return Boolean(floorCold) || Boolean(mindCold);
}

// Lower median; failures arrive as Infinity so they sort last and count in the denominator.
export function medianWithFailures(values) {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
}

export function p90WithFailures(values) {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor(0.9 * (s.length - 1))] : NaN;
}

// Warm rows plus every failed row (a failed first call is still a miss).
export function latencyCell(rows, model, pathName, bar) {
  const counted = rows.filter((x) => x.model === model && x.path === pathName && (x.failed || !x.cold));
  const values = counted.map((x) => (x.failed ? Infinity : x.total));
  const med = medianWithFailures(values);
  const failed = counted.filter((x) => x.failed).length;
  // The lower median can hide a coin-flip half of failures, so half or more failed is a miss outright.
  return { n: counted.length, failed, med, p90: p90WithFailures(values), bar, pass: Number.isFinite(med) && med < bar && failed * 2 < counted.length };
}

export function summarizeModel({ rows, floorResults, model, bar = BAR }) {
  const name = latencyCell(rows, model, 'name', bar.nameMs);
  const lead = latencyCell(rows, model, 'lead', bar.leadMs);
  const mine = floorResults.filter((f) => f.model === model);
  const ok = mine.filter((f) => f.ok).length;
  const floor = { ok, n: mine.length, pass: ok >= bar.floorOk };
  const latencyPass = name.pass && lead.pass;
  return { model, name, lead, latencyPass, floor, pass: latencyPass && floor.pass };
}

function misses(models) {
  const latency = models.filter((m) => !m.latencyPass).map((m) => m.model);
  const floor = models.filter((m) => !m.floor.pass).map((m) => m.model);
  const parts = [];
  if (latency.length) parts.push(`latency (${latency.join(', ')})`);
  if (floor.length) parts.push(`floor (${floor.join(', ')})`);
  return parts.join('; ');
}

// plan / api: an array of summarizeModel results, or null when that arm did not run.
export function verdictLines({ plan, api }) {
  const out = [];
  if (!plan) {
    out.push('Plan arm not run: no verdict on the product path from this run.');
  } else {
    const best = plan.find((m) => m.pass);
    out.push(best
      ? `The claude -p arm meets the bar with \`${best.model}\` as the mind model (latency and floor). Keep the plan path.`
      : `PLAN PATH MISSES THE BAR: stop and ask the operator whether to pay for the Messages API for the huddle alone (D28). Do not change the product path without that answer. Missed: ${misses(plan)}.`);
  }
  if (!api) {
    out.push('api arm: not run (measurement only).');
  } else {
    const best = api.find((m) => m.pass);
    out.push(best ? `api arm: PASS with \`${best.model}\` (measurement only).` : `api arm: MISS (measurement only). Missed: ${misses(api)}.`);
  }
  return out;
}
