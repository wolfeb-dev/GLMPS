// Card glmps-2-0-runtime-93: spans of the kernel's boot, timed from process
// start, so a block the event-loop monitor sees before the first request is
// named rather than inferred. performance.now() counts from the process's
// time origin, which makes the first span the module import.
import { performance } from 'node:perf_hooks';

const fmt = (ms) => Math.round(ms).toLocaleString('en-US');

export function createBootTrace({ now = () => performance.now() } = {}) {
  let last = 0;
  const spans = [];
  const push = (name, waited) => {
    const t = now();
    spans.push({ name, ms: Math.round(t - last), endMs: Math.round(t), waited });
    last = t;
  };
  const blocks = ({ thresholdMs = 200 } = {}) => spans.filter((s) => !s.waited && s.ms >= thresholdMs);
  return {
    mark: (name) => push(name, false),
    // A span that contains an await: its length is wall time, not a block.
    waited: (name) => push(name, true),
    spans: () => spans.map((s) => ({ ...s })),
    blocks,
    line({ thresholdMs = 200 } = {}) {
      const b = blocks({ thresholdMs });
      const ready = spans.length ? spans[spans.length - 1].endMs : 0;
      const tail = b.length
        ? `blocks of ${thresholdMs} ms or more: ${b.map((s) => `${s.name} ${fmt(s.ms)} ms`).join(', ')}`
        : `no block of ${thresholdMs} ms or more`;
      return `boot trace: ready ${fmt(ready)} ms after process start; ${tail}`;
    },
  };
}
