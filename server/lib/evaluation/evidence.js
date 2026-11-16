// server/lib/evaluation/evidence.js
// A metric is reported as an evidence-tagged object, not a bare value, so a
// dead or fabricated number can never be mistaken for a real measurement.
// Pure, zero deps.

export const MIN_CONSTANT_N = 10;

/**
 * @param {number|boolean|null} value   the already-computed aggregate (e.g. a median or rate)
 * @param {Array<number|boolean>} samples   the raw non-null values it was computed from
 * @param {{ reason?: string }} [opts]
 * @returns {{ value: any, evidence: 'measured'|'constant'|'absent', n: number, reason?: string }}
 */
export function tagValue(value, samples, { reason } = {}) {
  const list = Array.isArray(samples) ? samples : [];
  const n = list.length;
  if (n === 0) {
    const out = { value: null, evidence: 'absent', n: 0 };
    if (reason) out.reason = reason;
    return out;
  }
  const first = list[0];
  const zeroVariance = list.every((v) => v === first);
  if (zeroVariance && n >= MIN_CONSTANT_N) {
    const out = { value, evidence: 'constant', n };
    out.reason = reason ?? 'zero variance';
    return out;
  }
  return { value, evidence: 'measured', n };
}
