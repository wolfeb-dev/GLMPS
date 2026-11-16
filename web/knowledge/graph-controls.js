// web/knowledge/graph-controls.js
// The knowledge-graph list with per-row rebuild, "Rebuild all stale" and
// "Secondary scan", mounted in Knowledge > Architecture graph. They lived in a
// Settings > Knowledge tab until card glmps-2-0-140 moved knowledge into this
// lens. All data reaches the DOM through textContent.
import { graphStatus, rebuildGraph } from '../shared/api.js';
import { openGraphScanPanel } from '../shared/graph-scan-panel.js';

function relativeTime(ms) {
  if (ms == null) return '\u2014';
  const diff = Math.max(0, Date.now() - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(diff / 3600000);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function capStyle(label) {
  const el = document.createElement('div');
  el.className = 'set-cap-style';
  el.textContent = label;
  return el;
}

function buildGraphSection(menu) {
  const wrap = document.createElement('div');
  wrap.className = 'set-section';

  const divider = document.createElement('div');
  divider.className = 'set-divider';
  wrap.appendChild(divider);

  wrap.appendChild(capStyle('Knowledge graph'));

  const list = document.createElement('div');
  list.className = 'set-graph-list';
  list.textContent = '\u2026';
  wrap.appendChild(list);

  const footer = document.createElement('div');
  footer.className = 'set-graph-footer';

  const rebuildAllBtn = document.createElement('button');
  rebuildAllBtn.className = 'set-action-btn';
  rebuildAllBtn.type = 'button';
  rebuildAllBtn.textContent = 'Rebuild all stale';
  // toasted "Graphs rebuilt" unconditionally, even when
  // rebuildGraph's real response (server/server.js) carries a non-empty
  // skipped[] for roots that were already busy - those were never actually
  // rebuilt by this request. api.js now rejects on a true failure, so the
  // catch's "Rebuild failed" names the real reason too.
  rebuildAllBtn.addEventListener('click', async () => {
    rebuildAllBtn.disabled = true;
    rebuildAllBtn.textContent = 'Rebuilding\u2026';
    window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Rebuilding stale graphs\u2026' }));
    try {
      const result = await rebuildGraph();
      const n = result?.skipped?.length ?? 0;
      // Past the server's reply budget the rebuild continues in the background
      // and the server answers 202 (card glmps-2-0-runtime-148). running lists
      // every root in flight server-wide, so only the 202 says this one is.
      const running = result?.running?.length ?? 0;
      window.dispatchEvent(new CustomEvent('mc-toast', {
        detail: result?.pending ? `Rebuild continues in the background (${running} running)`
          : n > 0 ? `Graphs rebuilt (${n} already rebuilding, skipped)` : 'Graphs rebuilt',
      }));
      refreshGraphList(list, rebuildAllBtn);
    } catch (err) {
      window.dispatchEvent(new CustomEvent('mc-toast', { detail: `Rebuild failed: ${err.message}` }));
      rebuildAllBtn.disabled = false;
      rebuildAllBtn.textContent = 'Rebuild all stale';
    }
  });
  footer.appendChild(rebuildAllBtn);
  // Which repos besides the ship graph get indexed (card glmps-2-0-101).
  const scanBtn = document.createElement('button');
  scanBtn.className = 'set-action-btn';
  scanBtn.type = 'button';
  scanBtn.textContent = 'Secondary scan\u2026';
  scanBtn.addEventListener('click', () => openGraphScanPanel());
  footer.appendChild(scanBtn);
  wrap.appendChild(footer);

  menu.appendChild(wrap);
  return { list, rebuildAllBtn };
}

async function refreshGraphList(list, rebuildAllBtn) {
  list.textContent = '\u2026';
  try {
    const { graphs } = await graphStatus();
    list.textContent = '';
    if (!graphs || graphs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'set-graph-empty';
      empty.textContent = 'No graphs yet.';
      list.appendChild(empty);
    } else {
      graphs.forEach(g => {
        const item = document.createElement('div');
        item.className = 'set-graph-row';

        const top = document.createElement('div');
        top.className = 'set-graph-top';

        const name = document.createElement('span');
        name.className = 'set-graph-name';
        name.textContent = String(g.project || g.root || '(unknown)');
        top.appendChild(name);

        if (g.needsUpdate) {
          const pill = document.createElement('span');
          pill.className = 'set-needs-update';
          pill.textContent = 'needs update';
          top.appendChild(pill);
        } else if (g.freshness === 'unknown') {
          // Not the same claim as "needs update". We cannot tell whether this
          // graph is behind, and silence would render that as healthy.
          const pill = document.createElement('span');
          pill.className = 'set-freshness-unknown';
          pill.textContent = 'freshness unknown';
          pill.title = 'This graph carries no build marker, so it cannot be checked against HEAD. Rebuilding it restores the marker.';
          top.appendChild(pill);
        }

        item.appendChild(top);

        const sub = document.createElement('div');
        sub.className = 'set-graph-sub';
        const rebuilt = relativeTime(g.rebuiltMs);
        const nodes = g.nodes != null ? g.nodes.toLocaleString() : '\u2014';
        sub.textContent = `Rebuilt ${rebuilt} \u00B7 ${nodes} nodes`;
        item.appendChild(sub);

        // toasted "rebuilt" unconditionally, even for a
        // root the real route (server/server.js) answers with a non-empty
        // skipped[] for (already rebuilding elsewhere) - that row stayed
        // "busy" forever since refreshGraphList (which clears it) was only
        // called on this same, wrongly-assumed success path.
        item.addEventListener('click', async () => {
          if (item.classList.contains('busy')) return;
          item.classList.add('busy');
          const proj = String(g.project || g.root || '');
          window.dispatchEvent(new CustomEvent('mc-toast', { detail: `Rebuilding ${proj}\u2026` }));
          try {
            const result = await rebuildGraph(g.root);
            if (result?.skipped?.length > 0) {
              window.dispatchEvent(new CustomEvent('mc-toast', { detail: `${proj} is already rebuilding` }));
              item.classList.remove('busy');
              return;
            }
            window.dispatchEvent(new CustomEvent('mc-toast', {
              detail: result?.pending ? `${proj}: rebuild continues in the background` : `${proj}: rebuilt`,
            }));
            refreshGraphList(list, rebuildAllBtn);
          } catch (err) {
            window.dispatchEvent(new CustomEvent('mc-toast', { detail: `${proj}: rebuild failed: ${err.message}` }));
            item.classList.remove('busy');
          }
        });

        list.appendChild(item);
      });
    }

    // Re-enable rebuild-all after list refresh
    if (rebuildAllBtn) {
      rebuildAllBtn.disabled = false;
      rebuildAllBtn.textContent = 'Rebuild all stale';
    }
  } catch {
    list.textContent = '';
    const err = document.createElement('div');
    err.className = 'set-graph-empty';
    err.textContent = 'Could not load graphs.';
    list.appendChild(err);
    if (rebuildAllBtn) {
      rebuildAllBtn.disabled = false;
      rebuildAllBtn.textContent = 'Rebuild all stale';
    }
  }
}

/** Mount the graph controls into host and load the list. */
export function mountGraphControls(host) {
  const { list, rebuildAllBtn } = buildGraphSection(host);
  const ready = refreshGraphList(list, rebuildAllBtn);
  return { list, rebuildAllBtn, ready };
}
