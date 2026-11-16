// server/lib/plugins/retry-queue.js
//
// NDJSON job queue that survives a restart. Used by the memory plugin loop
// (D23/D24 cutover): a plugin failure never loses the work, it queues here
// and the retry tick (server.js) drains it later.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function createRetryQueue({ file, now = Date.now, onCorrupt, onOk } = {}) {
  // parse each line independently. The original
  // `.split('\n').map(JSON.parse)` threw inside .map() on the FIRST torn or
  // corrupt line, the outer try/catch caught it, and read() returned [] --
  // silently discarding every OTHER, perfectly good job in the file too.
  // Skipping (and counting) only the lines that fail to parse is the whole
  // point of the fix; onCorrupt surfaces that count so the caller (the
  // plugin-retry loop, K Task 6) can raise a visible failure instead of the
  // corruption going unnoticed.
  const read = () => {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const jobs = [];
    let corrupt = 0;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        jobs.push(JSON.parse(line));
      } catch {
        corrupt++;
      }
    }
    if (corrupt > 0 && typeof onCorrupt === 'function') {
      try {
        onCorrupt(corrupt, file);
      } catch {
        // A reporting hook must never break the read it is reporting on.
      }
    } else if (corrupt === 0 && typeof onOk === 'function') {
      // a clean read ends any earlier corruption
      // episode (health.js's clearMiss(), wired in by the caller) - a
      // torn-line failure that was later fixed by an operator (or simply
      // never recurred) must not stay flagged degraded forever.
      try {
        onOk();
      } catch {
        // Same as onCorrupt above: a reporting hook must never break the read.
      }
    }
    return jobs;
  };
  const write = (jobs) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, jobs.map((j) => JSON.stringify(j)).join('\n') + (jobs.length ? '\n' : ''));
    fs.renameSync(tmp, file);
  };
  return {
    push(job) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // if the file's last write was torn (e.g. a
      // crash mid-append left no trailing newline), appending straight onto
      // it would concatenate this job's JSON onto the end of that partial
      // line, corrupting BOTH. A one-byte read of the file's last
      // character is enough to detect this without reading the whole file.
      let prefix = '';
      try {
        const size = fs.statSync(file).size;
        if (size > 0) {
          const fd = fs.openSync(file, 'r');
          const buf = Buffer.alloc(1);
          fs.readSync(fd, buf, 0, 1, size - 1);
          fs.closeSync(fd);
          if (buf[0] !== 0x0a) prefix = '\n';
        }
      } catch {
        // File does not exist yet: nothing to be torn, no prefix needed.
      }
      fs.appendFileSync(file, prefix + JSON.stringify({ id: crypto.randomUUID(), ts: now(), attempts: 0, ...job }) + '\n');
    },
    // a job carrying `notBefore` (judge-
    // on-quiescence) is skipped entirely when it is not due yet - filtered
    // out BEFORE slicing to n, so a not-due job never consumes one of the n
    // slots this tick and never blocks a due job behind it (same fairness
    // concern as B1's bump-to-end fix). A job with no `notBefore` is always
    // due, unchanged from before this field existed.
    take(n, { now = Date.now() } = {}) {
      return read().filter((j) => !j.notBefore || j.notBefore <= now).slice(0, n);
    },
    // one durable job per match - a later ping for the same session
    // (or any other logically-single job) updates it in place (id and
    // attempts preserved) instead of appending a duplicate.
    upsert(match, fields) {
      const jobs = read();
      const idx = jobs.findIndex(match);
      if (idx === -1) {
        jobs.push({ id: crypto.randomUUID(), ts: now(), attempts: 0, ...fields });
      } else {
        jobs[idx] = { ...jobs[idx], ...fields };
      }
      write(jobs);
    },
    ack(id) { write(read().filter((j) => j.id !== id)); },
    // a bumped job moves to the end of the
    // file instead of staying in place. take(n) always takes the first n, so
    // leaving a failing job at the head starved every job behind it for as
    // long as it kept failing (up to 10 attempts, ~50 minutes at the 5-minute
    // tick) - a run of always-failing jobs could block a healthy one
    // indefinitely. Moving it to the end gives the next job a turn on the
    // very next tick, same as any fair round-robin retry queue.
    bump(id) {
      const jobs = read();
      const idx = jobs.findIndex((j) => j.id === id);
      if (idx === -1) return;
      const [job] = jobs.splice(idx, 1);
      jobs.push({ ...job, attempts: (job.attempts || 0) + 1 });
      write(jobs);
    },
    size() { return read().length; },
  };
}
