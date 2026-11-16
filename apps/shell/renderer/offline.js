// apps/shell/renderer/offline.js
// Renders the view object from status-format.js offlineView(). Text only
// (textContent), never innerHTML: reasons come from the network and sc.exe.
const $ = (id) => document.getElementById(id);
const api = window.glmpsOffline;
let countdownTimer = 0;

function setText(id, text) {
  const el = $(id);
  el.textContent = text || '';
  el.hidden = !text;
}

function render(v) {
  $('headline').textContent = v.headline;
  setText('lead', v.lead);
  setText('hint', v.hint);
  setText('command', v.command);
  setText('footer', v.footer);
  const facts = $('facts');
  facts.replaceChildren();
  for (const [label, value] of v.rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    facts.append(dt, dd);
  }
  $('retry').hidden = !v.actions.includes('retry');
  $('logs').hidden = !v.actions.includes('open-logs');
  clearInterval(countdownTimer);
  const cd = $('countdown');
  if (v.nextCheckTs) {
    const tick = () => { const s = Math.max(0, Math.ceil((v.nextCheckTs - Date.now()) / 1000)); cd.textContent = s ? `Next check in ${s} s.` : 'Checking now.'; };
    tick();
    cd.hidden = false;
    countdownTimer = setInterval(tick, 1000);
  } else {
    cd.hidden = true;
  }
}

api.onState(render);
$('retry').addEventListener('click', () => api.retry());
$('logs').addEventListener('click', () => api.openLogs());
