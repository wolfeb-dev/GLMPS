#!/usr/bin/env node
// Stop hook: scans the just-ended session transcript for capability gaps,
// upserts them into the learning store, files a backlog ticket for explicitly-
// deferred work, and refreshes graphify if code files changed.
//
// Stdin: Claude Code Stop-hook JSON { transcript_path, cwd, session_id, stop_hook_active }.
// Always exits 0 - must never block the stop.

// CLI entry guard - only run when invoked directly, not when imported by tests.
import { fileURLToPath } from 'node:url';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  import('node:fs').then(({ default: fs }) => {
    import('node:path').then(({ default: path }) => {
      import('node:os').then(({ default: os }) => {
        run(fs, path, os).catch(() => process.exit(0));
      });
    });
  });
}

async function run(fs, path, os) {
  // The memory distiller's own headless `claude -p` extraction session carries
  // GLMPS_MEMORY_DISTILL. Bail immediately so none of our capture/feed/ping machinery
  // runs on it - no self-enqueue, no spurious gap tickets, no graphify churn.
  if (process.env.GLMPS_MEMORY_DISTILL) { process.exit(0); }

  let raw = '';
  process.stdin.setEncoding('utf8');
  await new Promise((resolve) => {
    process.stdin.on('data', d => { raw += d; });
    process.stdin.on('end', resolve);
    process.stdin.on('error', resolve);
  });

  try {
    const inp = JSON.parse(raw || '{}');
    const transcriptPath = inp.transcript_path ?? null;
    const cwd = inp.cwd ?? process.cwd();
    const sessionId = inp.session_id ?? 'unknown';

    // Silently exit if no transcript
    if (!transcriptPath) { process.exit(0); }
    if (!fs.existsSync(transcriptPath)) { process.exit(0); }

    let rawContent;
    try { rawContent = fs.readFileSync(transcriptPath, 'utf8'); }
    catch { process.exit(0); }

    const lines = rawContent.split('\n').filter(Boolean);

    // Literal specifiers relative to this hook, so the tap bundle (apps/tap) can inline them.
    const hooksDir = path.dirname(fileURLToPath(import.meta.url));

    const { extractClaudeEvents } = await import(
      '../server/lib/observability/extract-claude.js'
    );

    const events = [];
    const skillsUsed = [];
    for (const line of lines) {
      const evs = extractClaudeEvents(line, sessionId);
      for (const e of evs) {
        events.push(e);
        if (e.kind === 'skill' && e.label && !skillsUsed.includes(e.label)) {
          skillsUsed.push(e.label);
        }
      }
    }

    let lastText = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
          for (let j = obj.message.content.length - 1; j >= 0; j--) {
            const c = obj.message.content[j];
            if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
              lastText = c.text.trim();
              break;
            }
          }
        } else if (obj.type === 'user') {
          const content = obj.message?.content;
          if (typeof content === 'string' && content.trim()) {
            lastText = content.trim();
          } else if (Array.isArray(content)) {
            for (let j = content.length - 1; j >= 0; j--) {
              const c = content[j];
              if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
                lastText = c.text.trim();
                break;
              }
            }
          }
        }
        if (lastText) break;
      } catch { /* skip unparseable lines */ }
    }

    const project = path.basename(cwd);

    const { feedFromTranscript } = await import(
      '../server/lib/observability/capability-feed-core.js'
    );
    const { gaps, ticket, codeChanged } = feedFromTranscript({ events, lines, skillsUsed, project, sessionId, lastText, cwd });

    // The stores live on the server, and this hook may run on a client, so the
    // writes go to the server (on a client: the tap relay on this same port,
    // which queues them while the server is away). Only when the connection
    // never opened is the server down, and then the direct write below keeps
    // the single-box behaviour. An HTTP error answer is not a fallback: the
    // server got the request.
    const { postIngest } = await import(
      '../server/lib/ingest-post.js'
    );

    if (gaps.length > 0) {
      // project is the raw cwd, NOT the basename or a pre-slugged key: upsertGapInto
      // canonicalizes it (projectKey), and only a raw path lets it fold a
      // worktree into its parent repo. The basename threw the path away, so the
      // same repo keyed differently from the live-server / synth writers.
      const sent = await postIngest('/api/ingest/learning-gaps', {
        project: cwd, sessionId,
        gaps: gaps.map(g => ({ code: g.code, severity: g.severity, message: typeof g.message === 'string' ? g.message.slice(0, 2000) : undefined })),
      });
      if (!sent.sent) {
        const { getPaths } = await import(
          '../server/lib/paths.js'
        );
        const P = getPaths();
        const learningStore = await import(
          '../server/lib/evaluation/learning-store.js'
        );
        const { coveredCodesFromFile } = await import(
          '../server/lib/evaluation/guard-coverage.js'
        );
        const coveredCodes = coveredCodesFromFile(path.join(P.assetsDir, 'CLAUDE.global.md'));
        for (const gap of gaps) {
          try { learningStore.upsertGap(P.stateDir, gap, { project: cwd, sessionId, coveredCodes }); }
          catch { /* fail-open: never block stop */ }
        }
      }
    }

    if (ticket !== null) {
      try {
        const sent = await postIngest('/api/ingest/backlog-ticket', {
          project,
          title: ticket.title,
          prompt: String(ticket.prompt ?? '').slice(0, 64 * 1024),
          source: ticket.source,
          state: ticket.state,
          sessionId, // attribute the follow-up ticket to the session that filed it
        });
        if (!sent.sent) {
          const { getPaths } = await import(
            '../server/lib/paths.js'
          );
          const backlogStore = await import(
            '../server/lib/orchestration/backlog-store.js'
          );
          backlogStore.addItemTo(getPaths().stateDir, {
            project,
            title: ticket.title,
            prompt: ticket.prompt,
            source: ticket.source,
            state: ticket.state,
            sessionId,
          });
        }
      } catch { /* fail-open */ }
    }

    // Notify the improvements loop the session ended (fail-open, bounded
    //     ~1.5s) so /api/outcomes/finalize can record an outcome row. A down
    //     dashboard server (or any network error) is fine - never block Stop. ---
    try {
      const { pingOutcomesFinalize } = await import(
        '../server/lib/evaluation/outcome-finalize-ping.js'
      );
      await pingOutcomesFinalize(sessionId);
    } catch { /* fail-open: server down or unreachable is fine */ }

    // Ping the memory distiller (fail-open). The server enqueues + distills
    //     this session; if it is down, the idle sweeper picks the session up
    //     later. Skip when we are ourselves a distiller-spawned extraction
    //     session (GLMPS_MEMORY_DISTILL set) so we never self-enqueue. ---
    if (!process.env.GLMPS_MEMORY_DISTILL) {
      try {
        let cfgRaw = {};
        try { cfgRaw = JSON.parse(fs.readFileSync(path.join(hooksDir, '..', 'config.json'), 'utf8')); } catch { /* no config -> defaults */ }
        const { getMemoryDistillConfig } = await import(
          '../server/lib/evaluation/memory-distill-config.js'
        );
        if (getMemoryDistillConfig(cfgRaw).enabled) {
          const { pingMemoryDistill } = await import(
            '../server/lib/evaluation/memory-distill-ping.js'
          );
          await pingMemoryDistill(sessionId, transcriptPath, cwd);
        }
      } catch { /* fail-open */ }
    }

    if (codeChanged) {
      try {
        // graphify-out/graph.json can live at cwd or cwd/server
        let graphRoot = null;
        for (const sub of ['', 'server']) {
          const candidate = path.join(cwd, sub, 'graphify-out', 'graph.json');
          if (fs.existsSync(candidate)) { graphRoot = path.join(cwd, sub); break; }
        }
        if (graphRoot) {
          const { spawn } = await import('node:child_process');
          // windowsHide (CREATE_NO_WINDOW) gives the child its OWN hidden console
          // that graphify's workers inherit. Never combine with detached on
          // Windows: DETACHED_PROCESS overrides CREATE_NO_WINDOW, the cmd runs
          // console-less, and every console child pops a visible Terminal window
          // (this was the recurring "graphify popup" at end of turn). Children
          // survive parent exit on Windows without detached.
          const child = spawn('graphify', ['update', graphRoot], {
            detached: process.platform !== 'win32',
            windowsHide: true,
            stdio: 'ignore',
            shell: true,
          });
          child.unref();
        }
      } catch { /* fail-open: graphify is best-effort */ }
    }

  } catch {
    // Top-level fail-open: a hook bug must never trap the user
  }

  process.exit(0);
}
