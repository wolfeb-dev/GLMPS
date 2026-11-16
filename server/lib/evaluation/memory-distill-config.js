// D23/D24 cutover: `model`, `confidenceThreshold`
// and `maxFactsPerSession` were the pre-D23 LLM-extraction pipeline's own
// knobs (which model to spawn, the confidence/dedup gate's threshold, the
// per-session fact cap); Mem0 now does extraction and admission with no
// local gate, so none of the three are read anywhere. `engine` is a fourth
// field of the same era and is very likely also dead (nothing in the repo
// reads it either), but it was not named in this fix round's explicit list,
// so it is left as-is rather than removed speculatively.
export const DEFAULTS = Object.freeze({
  enabled: true, engine: 'claude',
  minTranscriptBytes: 2000,
  sweepIdleMs: 2700000, sweepIntervalMs: 900000, sweepBackfill: false,
});
export function getMemoryDistillConfig(configJson) {
  const o = (configJson && typeof configJson === 'object' && configJson.memoryDistill
    && typeof configJson.memoryDistill === 'object') ? configJson.memoryDistill : {};
  return { ...DEFAULTS, ...o };
}
