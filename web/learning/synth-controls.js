// web/learning/synth-controls.js
// The learning loop's last-run status and "Run now", mounted in the Learning
// lens. They lived in a Settings > Knowledge tab until card glmps-2-0-140.
import { learningStatus, runSynth } from '../shared/api.js';

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

function buildLearningSection(menu) {
  const wrap = document.createElement('div');
  wrap.className = 'set-section';

  const divider = document.createElement('div');
  divider.className = 'set-divider';
  wrap.appendChild(divider);

  wrap.appendChild(capStyle('Learning loop'));

  const statusLine = document.createElement('div');
  statusLine.className = 'set-learning-status';
  statusLine.textContent = '\u2026';
  wrap.appendChild(statusLine);

  const runBtn = document.createElement('button');
  runBtn.className = 'set-action-btn';
  runBtn.type = 'button';
  runBtn.textContent = 'Run now';
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    runBtn.textContent = 'Running\u2026';
    window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Running synthesizer\u2026' }));
    try {
      const result = await runSynth();
      const msg = result.ok
        ? `${result.upserted ?? 0} gaps from ${result.scanned ?? 0} sessions`
        : (result.message || 'Synthesizer failed');
      window.dispatchEvent(new CustomEvent('mc-toast', { detail: msg }));
      refreshLearningStatus(statusLine, runBtn);
    } catch {
      window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Synthesizer failed' }));
      runBtn.disabled = false;
      runBtn.textContent = 'Run now';
    }
  });
  wrap.appendChild(runBtn);

  menu.appendChild(wrap);
  return { statusLine, runBtn };
}

async function refreshLearningStatus(statusLine, runBtn) {
  try {
    const data = await learningStatus();
    const when = data.lastRunMs != null ? `Last synthesized ${relativeTime(data.lastRunMs)}` : 'Never run';
    const pending = data.pending != null ? ` \u00B7 ${data.pending} pending` : '';
    statusLine.textContent = when + pending;
  } catch {
    statusLine.textContent = 'Status unavailable.';
  } finally {
    if (runBtn) {
      runBtn.disabled = false;
      runBtn.textContent = 'Run now';
    }
  }
}

/** Mount the learning-loop controls into host and load the status. */
export function mountSynthControls(host) {
  const { statusLine, runBtn } = buildLearningSection(host);
  const ready = refreshLearningStatus(statusLine, runBtn);
  return { statusLine, runBtn, ready };
}
