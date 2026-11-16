// web/evaluation/registry.js
// Capability Registry, Evolution pillar View 2 (glmps-138 Task 6). One
// unified, filterable table over every capability kind (guard/skill/memory/
// research-candidate/cross-agent-memory). Each row's lifecycle state is
// computed by registry-state.js's mapToLifecycle(); a guard/skill
// retire-candidate measurable is never a separate row, it is folded onto its
// own guard/skill row as the 'deprecated' state plus an inline retire action
// (the design spec's "key unification", collapsing the old Scoreboard tab's
// function into these rows).
//
// Read + ACTION view only, no store is merged or mutated directly here.
// Every mutating call below reuses an EXISTING endpoint: most already have a
// wrapper in shared/api.js (imported, not duplicated); three do not yet
// (GET /api/measurables, GET /api/skills/lifecycle-candidates,
// POST /api/skills/lifecycle/:id/reject) so this file adds its own small raw
// fetch helpers for exactly those three, mirroring scoreboard.js's existing
// inline-fetch precedent for /api/measurables. Nothing here invents a new
// server route.
//
// File ownership for this task is this file, registry.css, and
// capability-row.js only, api.js/app.js/index.html/styles.css are reserved
// for a later task and are not touched.
//
// XSS discipline: all server-derived strings reach the DOM via textContent/
// createElement (capability-row.js's `el`/setText). innerHTML is not used;
// containers are emptied with clear().
import { mapToLifecycle } from './registry-state.js';
import { agentRows } from './agent-rows.js';
import { renderLessonLedger } from './lesson-ledger-panel.js';
import { bindItem } from '../shared/interactive-item.js';
import { linkFor } from '../shared/deep-link.js';
import { clear } from '../shared/dom-util.js';
import {
  getLearning, learningAction,
  getLessons,
  getSkills,
  getAgents,
  getPersonality,
  releaseQuarantineSkillAdopt, approveSkillAdopt, startTrialSkillAdopt, resolveTrialSkillAdopt,
  getMemoryProposals, approveMemoryProposal, rejectMemoryProposal,
  getCrossAgentMemory, approveCrossAgentMemory, rejectCrossAgentMemory,
  releaseQuarantineCrossAgentMemory, startTrialCrossAgentMemory, pushCrossAgentMemory,
} from '../shared/api.js';
import {
  el, stateLabel, KIND_ORDER, CAPABILITY_KINDS, STATE_ORDER, buildKindChip, buildStateChip,
  staleInfo, fmtRelative, wireAction, buildActionsWrap, buildButton,
} from './capability-row.js';

export { renderRegistry, unmountRegistry, _registryContainerForTest, setRegistryFilter };

const PAGE_SIZE = 50;

// app.js's SSE handler dispatches a window 'mc-research-candidate' CustomEvent
// on every server-pushed research-candidate change (glmps-104). That listener
// used to live in the now-deleted research-candidates.js (its own standalone
// tab); research-candidate rows now render as part of this unified table, so
// the listener moves here unchanged in shape: bound once, and only re-renders
// while the Registry band is still mounted.
//
// this used to look up `#view-registry` by id at fire
// time and check `.classList.contains('hidden')` - both were 1.x-view-era
// mechanisms. Retiring `.view`/`#view-*` markup (D-surface Task 4) left
// `getElementById('view-registry')` returning null forever (the Learning
// lens's Registry band body never carried that id), so every live update
// silently stopped reaching the DOM. Holding the actual container reference,
// refreshed on every renderRegistry() call (a remount always passes a fresh
// band-body element), and checking `document.contains(container)` instead of
// a hidden class (there is no more hidden/shown toggling - a lens's bands
// exist only while that lens is mounted; unmounting removes them from the
// document entirely) is not id-dependent at all, so it cannot regress this
// way again. web/learning/lens.js still sets `id="view-registry"` on the
// band body too, matching the pattern used for the other five reused views,
// in case anything else ever needs it.
//
// No other kind rendered here (guard/skill/memory/cross-agent-memory) has a
// server-pushed SSE event of its own - server.js's only broadcast 'type'
// values are events/backlog/workspace/research-candidate/refresh/hello, and
// the retired guardrails.js/skills.js/scoreboard.js/memory.js views never
// subscribed to any of them either (confirmed by audit: none had an
// addEventListener('mc-...') of their own - guardrails' pending count was a
// nav-only badge, relocated onto this view's nav entry separately, see
// app.js's updateRegistryDot). So research-candidate is the only live-update
// wire this view needs for full parity with what was there before.
let _registryEventsBound = false;
let _registryContainer = null;
function bindRegistryEvents(container) {
  _registryContainer = container;
  if (_registryEventsBound) return;
  _registryEventsBound = true;
  window.addEventListener('mc-research-candidate', () => {
    const c = _registryContainer;
    // a stale reference is dropped here too (not just
    // skipped), so a detached container found this way is released on the
    // very next event, rather than waiting for the next unmount() call.
    if (!c || !document.contains(c)) { _registryContainer = null; return; }
    renderRegistry(c);
  });
}

// Unmount hook: web/learning/lens.js calls this when
// its Registry band is torn down (a lens change, e.g. navigating away from
// Learning). Without it, `_registryContainer` above kept a live reference to
// the now-detached subtree for as long as the page stayed open - the
// mc-research-candidate handler's `document.contains` guard stopped it from
// RE-RENDERING a detached tree, but did nothing to release the reference
// itself, so the whole detached DOM subtree (every row, every wired button)
// could never be garbage collected. Safe to call whether or not anything is
// currently mounted; the SSE listener itself stays bound (module-level,
// `_registryEventsBound`), it just becomes a no-op until the next mount.
function unmountRegistry() {
  _registryContainer = null;
  _repaintFilters = null;
}

// Test-only accessor: proves the module holds no
// container reference after unmount, rather than only inferring it from
// re-fire behaviour (which the document.contains guard alone already made
// safe, but did not prove the reference was actually released).
function _registryContainerForTest() {
  return _registryContainer;
}

// Filter/search/page state persists across a rerender() (glmps-138 fix pass:
// previously renderRegistry() built a fresh {kinds:ALL, states:ALL,
// search:'', page:1} on every call, so a single row action - which always
// triggers a full rerender() per this codebase's convention - silently
// snapped a filtered view back to "all", see wave2-review.md Registry Minor
// #2. Module-level (one shared mutable object, not a per-call local) so it
// survives both a row action's rerender() and switching away from/back to
// this tab. Each dynamic `import(...)` in tests gets its own fresh module
// instance, so this never leaks state across test files.
let persistedFilterState = null;
// Phase 2 (Q3): the Learning header's "Review N proposals" jumps straight to
// a filtered registry. The mounted view registers its chip/body repaint here;
// with nothing mounted the filter simply applies on the next render.
let _repaintFilters = null;
function setRegistryFilter({ kinds, states, search } = {}) {
  const st = getFilterState();
  if (Array.isArray(kinds)) st.kinds = new Set(kinds);
  if (Array.isArray(states)) st.states = new Set(states);
  if (typeof search === 'string') st.search = search;
  st.page = 1;
  _repaintFilters?.();
}

function getFilterState() {
  if (!persistedFilterState) {
    persistedFilterState = { kinds: new Set(KIND_ORDER), states: new Set(STATE_ORDER), search: '', page: 1 };
  }
  return persistedFilterState;
}

// (out of this task's file-ownership scope; api.js is not touched).
async function getMeasurables() {
  const r = await fetch('/api/measurables');
  if (!r.ok) throw new Error('measurables ' + r.status);
  return r.json();
}
async function getSkillLifecycleCandidates() {
  const r = await fetch('/api/skills/lifecycle-candidates');
  if (!r.ok) throw new Error('lifecycle-candidates ' + r.status);
  return r.json();
}
async function labelMeasurable(id, decision) {
  const r = await fetch(`/api/measurables/${encodeURIComponent(id)}/label`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision, by: 'operator' }),
  });
  if (!r.ok) throw new Error('label ' + r.status);
  return r.json();
}
// glmps-138: POST /api/skills/lifecycle/:id/reject exists on the server
// (glmps-19) but shared/api.js's skill-adopt section (written
// before that route landed) never grew a wrapper for it. Reusing the
// existing route, not inventing one.
async function rejectSkillAdopt(id, reason) {
  const r = await fetch(`/api/skills/lifecycle/${encodeURIComponent(id)}/reject`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: reason ?? null }),
  });
  if (!r.ok) throw new Error('reject ' + r.status);
  return r.json();
}
async function getMemoryUsage() {
  const r = await fetch('/api/memory/usage');
  if (!r.ok) throw new Error('memory usage ' + r.status);
  return r.json();
}
async function getMemoryEvictionPlan() {
  const r = await fetch('/api/memory/eviction-plan');
  if (!r.ok) throw new Error('memory eviction-plan ' + r.status);
  return r.json();
}
// Task 12 (tiered memory admission plan): curated/gate/recall/quarantined in
// one call - the read-only digest that fronts the memory kind, no wrapper in
// shared/api.js yet, same raw-fetch precedent as the two helpers above.
// (D23/D24 cutover, task 6: distilled/promotable dropped, see below.)
async function getMemoryDigest() {
  const r = await fetch('/api/memory/digest');
  if (!r.ok) throw new Error('memory digest ' + r.status);
  return r.json();
}

// Each returns unified capability rows:
// { kind, id, name, state, subLabel, provenance, lastUsedTs, detail, tier,
//   buildActions(rerender) => Node|null }

function buildGuardRows(learningItems, measurables) {
  const retireByCode = new Map();
  for (const m of measurables) {
    if (m?.kind === 'guard-retire' && m.evidence?.ref) retireByCode.set(m.evidence.ref, m);
  }
  const rows = [];
  for (const item of Array.isArray(learningItems) ? learningItems : []) {
    if (!item || typeof item !== 'object' || !item.id) continue;
    const cand = item.code ? retireByCode.get(item.code) : null;
    const lifecycle = mapToLifecycle({ type: 'guard', status: item.status, retireCandidate: !!cand });
    if (!lifecycle) continue; // discarded/failed/skipped, dropped per registry-state.js
    rows.push({
      kind: 'guard',
      id: `guard:${item.id}`,
      name: item.title || item.code || '(untitled guard)',
      state: lifecycle.state,
      subLabel: cand ? (cand.detail || 'retire candidate') : lifecycle.subLabel,
      provenance: item.project || item.sessionId || item.lastSessionId || null,
      lastUsedTs: numOrNull(item.updatedTs) ?? numOrNull(item.createdTs),
      detail: item.body || null,
      tier: 'free',
      buildActions: (rerender) => buildGuardActions(item, cand, rerender),
    });
  }
  return rows;
}

function buildSkillRows(adoptItems, skills, measurables) {
  const retireById = new Map();
  for (const m of measurables) {
    if (m?.kind === 'skill-retire' && m.evidence?.ref) retireById.set(m.evidence.ref, m);
  }
  const rows = [];
  for (const item of Array.isArray(adoptItems) ? adoptItems : []) {
    if (!item || typeof item !== 'object' || !item.id) continue;
    const lifecycle = mapToLifecycle({ type: 'skill', status: item.status });
    if (!lifecycle) continue; // rejected, dropped
    rows.push({
      kind: 'skill',
      id: `skill-adopt:${item.id}`,
      name: item.skill || item.id,
      state: lifecycle.state,
      subLabel: lifecycle.subLabel,
      provenance: item.provenance || item.source || null,
      lastUsedTs: numOrNull(item.ts),
      detail: null,
      tier: 'free',
      buildActions: (rerender) => buildSkillAdoptActions(item, rerender),
    });
  }
  for (const s of Array.isArray(skills) ? skills : []) {
    if (!s || typeof s !== 'object' || !s.id || !s.installed) continue;
    const cand = retireById.get(s.id);
    const lifecycle = mapToLifecycle({ type: 'skill', status: 'installed', retireCandidate: !!cand });
    rows.push({
      kind: 'skill',
      id: `skill-inv:${s.id}`,
      name: s.name || s.id,
      state: lifecycle.state,
      subLabel: cand ? (cand.detail || 'retire candidate') : lifecycle.subLabel,
      provenance: s.plugin || null,
      lastUsedTs: s.lastSeen ? Date.parse(s.lastSeen) : null,
      detail: s.description || null,
      tier: 'free',
      buildActions: (rerender) => (cand ? buildRetireLabelActions(cand, rerender) : null),
    });
  }
  return rows;
}

// Task 10 (glmps-138 agent-routing plan): the agent roster joins this same
// unified table rather than getting its own view. The mapping itself
// (agents + agent-retire measurables -> rows) is the pure agentRows()
// function above (testable under node:test with no DOM); this wrapper only
// adds the DOM-closure buildActions every other kind's row already carries.
//
// An agent-retire candidate is approved/rejected/pruned by exactly the same
// three buttons a guard or skill retire candidate uses (buildSkillRows wires
// the same helper), because the measurable-label endpoint behind it is
// kind-agnostic. Returning null here instead left a DEPRECATED agent row as
// the only deprecated row in the table with no way to act on it.
function buildAgentRows(agents, measurables) {
  return agentRows(agents, measurables).map(row => ({
    ...row,
    buildActions: (rerender) => (row.retireCandidate ? buildRetireLabelActions(row.retireCandidate, rerender) : null),
  }));
}

// Instruction files and harness code come from the Personality listing: the
// machine and project groups are Instructions, the runtime group is code that
// GLMPS applies around the AI. Agents, skills and memory files are already
// registry rows of their own kind, so those groups add nothing here.
const FILE_KIND_BY_GROUP = { machine: 'instructions', project: 'instructions', runtime: 'harness' };
function buildFileRows(personality) {
  const rows = [];
  for (const g of Array.isArray(personality?.groups) ? personality.groups : []) {
    const kind = FILE_KIND_BY_GROUP[g.id];
    if (!kind) continue;
    for (const c of Array.isArray(g.cards) ? g.cards : []) {
      if (!c || typeof c !== 'object' || !c.id) continue;
      rows.push({
        kind,
        id: `file:${c.id}`,
        name: c.name || c.id,
        state: 'active',
        subLabel: null,
        provenance: c.path || g.name || null,
        lastUsedTs: numOrNull(c.mtime),
        detail: c.controls || null,
        tier: 'free',
        buildActions: null,
      });
    }
  }
  return rows;
}

function buildMemoryRows(proposals) {
  const rows = [];
  for (const p of Array.isArray(proposals) ? proposals : []) {
    if (!p || typeof p !== 'object' || !p.id) continue;
    const lifecycle = mapToLifecycle({ type: 'memory', status: 'proposal' });
    rows.push({
      kind: 'memory',
      id: `memory:${p.id}`,
      name: p.fact?.name || '(unnamed fact)',
      state: lifecycle.state,
      subLabel: lifecycle.subLabel,
      provenance: p.sessionId || null,
      lastUsedTs: numOrNull(p.ts),
      detail: p.fact?.description || null,
      tier: 'free',
      buildActions: (rerender) => buildMemoryActions(p, rerender),
    });
  }
  return rows;
}

// glmps-155/156: written memory facts, with the measure + retire stages the
// memory kind previously lacked. buildMemoryRows above covers only PROPOSALS
// (the adopt stage), which is why memory used to appear in this registry
// without ever reaching an active or retired state.
//
// `detail` carries the evidence rather than a description, because the whole
// point of these rows is that retirement here is evidence-backed: reads
// measure drill-in demand, exposure is how many chances the fact actually had.
function buildMemoryFactRows(facts, plan) {
  const evicting = new Set((Array.isArray(plan) ? plan : []).map((p) => p && p.target).filter(Boolean));
  const rows = [];
  for (const f of Array.isArray(facts) ? facts : []) {
    if (!f || typeof f !== 'object' || !f.target) continue;
    const candidate = evicting.has(f.target);
    const lifecycle = mapToLifecycle({
      type: 'memory',
      status: 'written',
      retireCandidate: candidate,
    });
    const reads = Number(f.reads) || 0;
    const exposure = Number(f.exposureSessions) || 0;
    rows.push({
      kind: 'memory',
      id: `memory:fact:${f.target}`,
      name: f.target.replace(/\.md$/, ''),
      state: lifecycle.state,
      subLabel: candidate ? 'eviction candidate' : lifecycle.subLabel,
      provenance: null,
      lastUsedTs: numOrNull(f.lastRead),
      detail: `${reads} read${reads === 1 ? '' : 's'} across ${exposure} exposed session${exposure === 1 ? '' : 's'}`,
      tier: 'free',
      buildActions: null,
    });
  }
  return rows;
}


// glmps-138 fix pass: registry-state.js's CROSS_AGENT_MEMORY_STATE now has a
// real `dropped` set including 'rejected' (see registry-state.js), so
// mapToLifecycle itself returns null for a rejected candidate, same as
// buildGuardRows/buildSkillRows below - the client-side
// `item.status === 'rejected'` workaround this comment used to describe is
// no longer needed and has been removed.
function buildCrossAgentRows(items) {
  const rows = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object' || !item.id) continue;
    const lifecycle = mapToLifecycle({ type: 'cross-agent-memory', status: item.status });
    if (!lifecycle) continue; // rejected, dropped
    rows.push({
      kind: 'cross-agent-memory',
      id: `cam:${item.id}`,
      name: item.fact?.name || item.id,
      state: lifecycle.state,
      subLabel: lifecycle.subLabel,
      provenance: item.sourceProject || null,
      lastUsedTs: numOrNull(item.updatedTs) ?? numOrNull(item.createdTs),
      detail: item.fact?.description || null,
      tier: 'pro',
      buildActions: (rerender) => buildCamActions(item, rerender),
    });
  }
  return rows;
}

function numOrNull(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }


function buildRetireLabelActions(measurable, rerender) {
  const { wrap, status, buttons } = buildActionsWrap();
  const defs = [
    { label: 'Approve retire', decision: 'approve', variant: 'approve' },
    { label: 'Reject', decision: 'reject', variant: 'reject' },
    { label: 'Prune', decision: 'prune', variant: 'prune' },
  ];
  for (const def of defs) {
    const btn = buildButton(def.label, def.variant);
    buttons.push(btn);
    wrap.appendChild(btn);
    wireAction(btn, buttons, status, () => labelMeasurable(measurable.id, def.decision), rerender);
  }
  wrap.appendChild(status);
  return wrap;
}

function buildGuardActions(item, measurable, rerender) {
  if (measurable) return buildRetireLabelActions(measurable, rerender);
  if (item.status !== 'pending' && item.status !== 'dispatched') return null;

  const { wrap, status, buttons } = buildActionsWrap();
  const approveBtn = buildButton('Approve', 'approve');
  const discardBtn = buildButton('Discard', 'discard');
  const moreBtn = buildButton('More', 'more');
  // Guard proposer cutover: a gap item's own
  // proposedGuard is null until an operator sets one (via "Save
  // alternative" below) or a GEPA proposal carries one - approving one with
  // no rule now 400s server-side. Disable up front instead of letting the
  // operator discover that by clicking; a legacy item that already has a
  // rule (from before this cutover, or a GEPA/alternative rule) still
  // approves normally.
  if (!item.proposedGuard?.rule) {
    approveBtn.disabled = true;
    approveBtn.title = 'No guard rule yet - set one under "More" first';
  }
  buttons.push(approveBtn, discardBtn, moreBtn);
  wrap.append(approveBtn, discardBtn, moreBtn);
  wireAction(approveBtn, buttons, status, () => learningAction(item.id, 'approve'), rerender);
  wireAction(discardBtn, buttons, status, () => learningAction(item.id, 'discard'), rerender);

  // the row's own name is the server's
  // 80-char-truncated "Proposed guard: <rule>" title - show the FULL
  // proposed rule text next to Approve, not hidden behind "More" (that panel
  // is for setting an ALTERNATIVE rule, a different action from reading the
  // one on offer).
  if (item.proposedGuard?.rule) {
    wrap.appendChild(el('p', 'rg-detail rg-proposed-rule', item.proposedGuard.rule));
  }

  // Alternative + Promote, tucked behind "More" (table row real estate is
  // narrow); same two actions guardrails.js's card exposes up front.
  const more = el('div', 'rg-more rg-more-hidden');
  const altInput = document.createElement('textarea');
  altInput.className = 'rg-alt-textarea';
  altInput.rows = 2;
  altInput.placeholder = 'Alternative guard rule...';
  altInput.value = item.proposedGuard?.rule || '';
  const altBtn = buildButton('Save alternative', 'save');
  const promoteGlobalBtn = buildButton('Promote to Global', 'promote');
  const promoteMemoryBtn = buildButton('Promote to Memory', 'promote');
  buttons.push(altBtn, promoteGlobalBtn, promoteMemoryBtn);
  wireAction(altBtn, buttons, status, () => learningAction(item.id, 'alternative', altInput.value.trim()), rerender);
  wireAction(promoteGlobalBtn, buttons, status, () => learningAction(item.id, 'promote', 'global'), rerender);
  wireAction(promoteMemoryBtn, buttons, status, () => learningAction(item.id, 'promote', 'memory'), rerender);
  more.append(altInput, altBtn, promoteGlobalBtn, promoteMemoryBtn);
  moreBtn.addEventListener('click', () => more.classList.toggle('rg-more-hidden'));
  wrap.appendChild(more);
  wrap.appendChild(status);
  return wrap;
}

function numField(labelText, opts) {
  const label = el('label', 'rg-numfield');
  label.appendChild(el('span', 'rg-numfield-label', labelText));
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'rg-numfield-input';
  if (opts?.min != null) input.min = String(opts.min);
  if (opts?.max != null) input.max = String(opts.max);
  if (opts?.step != null) input.step = String(opts.step);
  label.appendChild(input);
  return { label, input };
}

function buildResolveTrialForm(id, buttons, status, rerender) {
  const wrap = el('div', 'rg-resolve-form');
  const nField = numField('Observations (n)', { min: 0, step: 1 });
  const cfField = numField('Counterfactual rate', { min: 0, max: 1, step: 0.01 });
  const frField = numField('Fire rate', { min: 0, max: 1, step: 0.01 });
  wrap.append(nField.label, cfField.label, frField.label);

  const resolveBtn = buildButton('Resolve trial', 'save');
  buttons.push(resolveBtn);
  wrap.appendChild(resolveBtn);

  const num = (input) => (input.value === '' ? undefined : Number(input.value));
  wireAction(resolveBtn, buttons, status, () => resolveTrialSkillAdopt(id, {
    n: num(nField.input), counterfactualRate: num(cfField.input), fireRate: num(frField.input),
  }), rerender);

  return wrap;
}

// Reject is reachable from any non-terminal skill-adopt status
// (skill-adopt-store.js's rejectCandidate: reachable from anything except
// 'kept'/'rejected'), so every open row below offers it alongside its
// state-specific forward action.
function buildSkillAdoptActions(item, rerender) {
  const { wrap, status, buttons } = buildActionsWrap();
  const add = (label, variant, run) => {
    const btn = buildButton(label, variant);
    buttons.push(btn);
    wrap.appendChild(btn);
    wireAction(btn, buttons, status, run, rerender);
  };

  switch (item.status) {
    case 'discovered':
    case 'quarantined':
      add('Release quarantine', 'release', () => releaseQuarantineSkillAdopt(item.id));
      break;
    case 'pending-approval':
      add('Approve', 'approve', () => approveSkillAdopt(item.id));
      break;
    case 'approved':
      add('Start trial', 'trial', () => startTrialSkillAdopt(item.id));
      break;
    case 'trialing':
      wrap.appendChild(buildResolveTrialForm(item.id, buttons, status, rerender));
      break;
    default:
      break;
  }
  if (item.status !== 'kept' && item.status !== 'rejected') {
    add('Reject', 'reject', () => rejectSkillAdopt(item.id, 'declined by operator'));
  }
  wrap.appendChild(status);
  return wrap;
}

function buildMemoryActions(p, rerender) {
  const { wrap, status, buttons } = buildActionsWrap();
  const approveBtn = buildButton('Approve', 'approve');
  const rejectBtn = buildButton('Reject', 'reject');
  buttons.push(approveBtn, rejectBtn);
  wrap.append(approveBtn, rejectBtn, status);
  wireAction(approveBtn, buttons, status, () => approveMemoryProposal(p.id), rerender);
  wireAction(rejectBtn, buttons, status, () => rejectMemoryProposal(p.id), rerender);
  return wrap;
}


// glmps-138 finding: cross-agent-memory-store.js has no "retire" transition
// at all (only quarantined -> pending-approval -> approved -> trialing ->
// kept|rejected via resolveTrial's verdict), so the design spec's action
// list ("Approve / Trial / Push / Retire") names an action with no backing
// endpoint. Reject is the closest real equivalent (terminal, reachable from
// any non-terminal status) and is what this wires instead of inventing a
// retire route (this task's hard constraint: reuse existing endpoints
// only). See FINDINGS.
function buildCamActions(item, rerender) {
  const { wrap, status, buttons } = buildActionsWrap();
  const add = (label, variant, run) => {
    const btn = buildButton(label, variant);
    buttons.push(btn);
    wrap.appendChild(btn);
    wireAction(btn, buttons, status, run, rerender);
  };
  if (item.status === 'quarantined') add('Release quarantine', 'release', () => releaseQuarantineCrossAgentMemory(item.id));
  else if (item.status === 'pending-approval') add('Approve', 'approve', () => approveCrossAgentMemory(item.id));
  else if (item.status === 'approved') add('Start trial', 'trial', () => startTrialCrossAgentMemory(item.id));
  if (item.status !== 'kept' && item.status !== 'rejected') {
    add('Reject', 'reject', () => rejectCrossAgentMemory(item.id));
  }
  wrap.appendChild(status);
  return wrap;
}

// Task 12 (tiered memory admission plan): renders GET /api/memory/digest's shape. Every value is
// file-derived (counts, byte totals, quarantined ids/flags), so - per this
// module's file-level XSS discipline comment above - it goes through
// textContent/createElement only; the container clear below is this file's
// one allowed exception.
//
// D23/D24 cutover (task 6): the 'distilled pool' (L3) and 'promotable now'
// rows are dropped along with the pipeline that produced those counts - Mem0
// has no "list everything" op to replace them with (see the route's own
// comment in server.js).
function renderMemoryDigest(root, d) {
  clear(root);
  const row = (label, value) => {
    const li = document.createElement('li');
    const k = document.createElement('span'); k.className = 'k'; k.textContent = label;
    const v = document.createElement('span'); v.className = 'v'; v.textContent = value;
    li.append(k, v); return li;
  };
  const ul = document.createElement('ul'); ul.className = 'digest';
  ul.append(
    row('curated index', `${d.curated.lines} lines, ${d.curated.bytes} / ${d.curated.budgetBytes} bytes`),
    row('curated recall@5', `${(d.recall.recallAtK * 100).toFixed(0)}% (${d.recall.total} probes)`),
    row('demotion gate', d.gate.allowed ? `open: ${d.gate.reason}` : `CLOSED: ${d.gate.reason}`),
    row('quarantined', String(d.quarantined.length)),
  );
  root.append(ul);
}


function buildTableRow(row, rerender) {
  const el_ = el('div', `rg-row rg-row--${row.state}`);

  el_.appendChild(buildKindChip(row.kind));

  const nameWrap = el('div', 'rg-name-wrap');
  nameWrap.appendChild(el('span', 'rg-name', row.name));
  if (row.detail) nameWrap.appendChild(el('p', 'rg-detail', row.detail));
  el_.appendChild(nameWrap);

  el_.appendChild(buildStateChip(row.state, row.subLabel));

  el_.appendChild(el('span', 'rg-provenance', row.provenance || 'unknown'));

  const stale = staleInfo(row.lastUsedTs);
  el_.appendChild(el('span', `rg-lastused ${stale.className}`, stale.label));

  const actionsHost = el('div', 'rg-actions-host');
  const actions = row.buildActions ? row.buildActions(rerender) : null;
  if (actions) actionsHost.appendChild(actions);
  else actionsHost.appendChild(el('span', 'rg-no-actions', '\u2013')); // en dash: "no action available" placeholder
  el_.appendChild(actionsHost);

  // D-surface Task 6: the whole row opens an inline detail and carries a
  // stable deep link (D17). Actions inside actionsHost keep their own click
  // handlers; stop that click from bubbling here so pressing Approve/Reject
  // does not also toggle the detail open/closed.
  const detail = document.createElement('div');
  detail.className = 'reg-row-detail';
  detail.hidden = true;
  // Filled on first open: a page of 50 rows would otherwise carry ~1,500
  // hidden detail nodes (phase 2, AC-5 DOM budget).
  let detailFilled = false;
  const fillDetail = () => {
    if (detailFilled) return;
    detailFilled = true;
    for (const [k, v] of Object.entries(row)) {
      if (v == null || typeof v === 'object') continue;
      const line = document.createElement('div');
      const key = document.createElement('code'); key.textContent = k;
      line.appendChild(key); line.appendChild(document.createTextNode(` ${v}`));
      detail.appendChild(line);
    }
  };
  el_.appendChild(detail);
  actionsHost.addEventListener('click', (ev) => ev.stopPropagation());

  bindItem(el_, {
    type: 'capability', id: row.id,
    link: linkFor({ lens: 'learning', tab: 'capabilities', sel: { type: 'capability', id: row.id } }),
    open: () => { fillDetail(); detail.hidden = !detail.hidden; }, label: `Registry row ${row.id}`,
  });

  return el_;
}


function buildFilterChip(label, active, onClick) {
  const btn = el('button', `rg-filter-chip${active ? ' rg-filter-chip--active' : ''}`, label);
  btn.type = 'button';
  btn.setAttribute('aria-pressed', String(active));
  btn.addEventListener('click', onClick);
  return btn;
}



// opts (Learning lens, phase 2): `slots` ({ memory }) are tab panels that
// receive the memory digest + shared memory instead of the registry's own deck; `pageAll` pages every kind at PAGE_SIZE
// (the guard proposals alone run to hundreds of rows). With no opts the view
// renders exactly as before.
async function renderRegistry(container, opts = {}) {
  if (!container) return;
  const slots = opts.slots ?? null;
  bindRegistryEvents(container);
  clear(container);
  container.classList.add('an-root', 'rg-root');
  if (slots) for (const slot of Object.values(slots)) clear(slot);

  if (!slots) {
    const header = el('div', 'exp-header');
    header.appendChild(el('span', 'exp-header-title', 'Capability Registry'));
    container.appendChild(header);
  }

  const loading = el('div', 'an-empty', 'Loading...');
  container.appendChild(loading);

  const rerender = () => renderRegistry(container, opts);

  const results = await Promise.allSettled([
    getLearning(),
    getLessons(),
    getMeasurables(),
    getSkillLifecycleCandidates(),
    getSkills(),
    getAgents(),
    getMemoryProposals(),
    getCrossAgentMemory(),
    getMemoryUsage(),
    getMemoryEvictionPlan(),
    getMemoryDigest(),
    getPersonality(),
  ]);
  loading.remove();

  const [learningR, lessonsR, measurablesR, skillCandR, skillsR, agentsR, memoryR, camR,
    memUsageR, memPlanR, memDigestR, personalityR] = results;
  const learningItems = learningR.status === 'fulfilled' ? (learningR.value?.items ?? []) : [];
  // null (not []) when the fetch failed, so the panel can say so rather than
  // render an empty ledger that looks like "nothing has ever landed".
  const lessonsData = lessonsR.status === 'fulfilled' ? (lessonsR.value ?? null) : null;
  const measurables = measurablesR.status === 'fulfilled' ? (measurablesR.value?.measurables ?? []) : [];
  const skillCandidates = skillCandR.status === 'fulfilled' ? (skillCandR.value?.items ?? []) : [];
  const skills = skillsR.status === 'fulfilled' ? (skillsR.value?.skills ?? []) : [];
  const agents = agentsR.status === 'fulfilled' ? (agentsR.value?.agents ?? []) : [];
  const memoryProposals = memoryR.status === 'fulfilled' ? (memoryR.value?.proposals ?? []) : [];
  const camItems = camR.status === 'fulfilled' ? (camR.value?.items ?? []) : [];
  const memFacts = memUsageR.status === 'fulfilled' ? (memUsageR.value?.facts ?? []) : [];
  const memPlan = memPlanR.status === 'fulfilled' ? (memPlanR.value?.plan ?? []) : [];
  const memDigest = memDigestR.status === 'fulfilled' ? memDigestR.value : null;
  const personality = personalityR.status === 'fulfilled' ? personalityR.value : null;

  if (results.every((r) => r.status === 'rejected')) {
    container.appendChild(el('div', 'an-empty', 'Capability Registry unavailable, every backing endpoint failed to respond.'));
    if (slots) for (const slot of Object.values(slots)) slot.appendChild(el('div', 'an-empty', 'Unavailable: every backing endpoint failed to respond.'));
    return;
  }

  const rows = [
    ...buildFileRows(personality),
    ...buildGuardRows(learningItems, measurables),
    ...buildSkillRows(skillCandidates, skills, measurables),
    ...buildAgentRows(agents, measurables),
    ...buildMemoryRows(memoryProposals),
    ...buildMemoryFactRows(memFacts, memPlan),
    ...buildCrossAgentRows(camItems),
  ];
  // Stable order: the six kinds as the operator reads them, not fetch order.
  rows.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));

  // Full-width per-kind panel of full-size stat tiles (guard/skill/memory/...),
  // pinned at the top of the view above the tiled deck and list.
  const summary = el('section', 'an-panel rg-summary');
  const totals = el('div', 'an-totals');
  for (const group of CAPABILITY_KINDS) {
    const n = rows.filter((r) => group.rowKinds.includes(r.kind)).length;
    const tile = el('div', 'an-stat');
    tile.appendChild(el('div', 'an-stat-value', String(n)));
    tile.appendChild(el('div', 'an-stat-label', group.label));
    totals.appendChild(tile);
  }
  summary.appendChild(totals);
  container.appendChild(summary);

  // Read-only, at-a-glance summary of the curated tier (index budget,
  // demotion gate, fault recall) plus quarantined proposals. This is the
  // primary memory view now; the per-row memory kind further down in the
  // table (still an approve/reject queue) is the detail drill-in and is
  // unchanged by this task. (D23/D24 cutover, task 6: the distilled L3 pool
  // and promotable-now rows are retired along with that pipeline.)
  const digestPanel = el('section', 'an-panel rg-digest-panel');
  digestPanel.appendChild(el('h2', 'an-panel-title', 'Memory digest'));
  const digestBody = el('div', 'an-panel-body');
  digestPanel.appendChild(digestBody);
  if (memDigest) renderMemoryDigest(digestBody, memDigest);
  else digestBody.appendChild(el('div', 'an-empty', 'Memory digest unavailable, GET /api/memory/digest failed to respond.'));
  // digestPanel is placed in the tiled deck below, not appended full-width here.

  // Filter/search/page state: see getFilterState()'s module-level doc above.
  const state = getFilterState();

  // One compact wrapping toolbar (kind group, state group, search) rather
  // than three full-width stacked rows; appended just above the list below.
  const filterBar = el('div', 'rg-filterbar');
  const kindRow = el('div', 'rg-filter-row');
  kindRow.setAttribute('role', 'group');
  kindRow.setAttribute('aria-label', 'Filter by kind');
  const stateRow = el('div', 'rg-filter-row');
  stateRow.setAttribute('role', 'group');
  stateRow.setAttribute('aria-label', 'Filter by state');

  const kindGroup = el('div', 'rg-filter-group');
  kindGroup.appendChild(el('span', 'rg-filter-group-label', 'Kind'));
  kindGroup.appendChild(kindRow);
  const stateGroup = el('div', 'rg-filter-group');
  stateGroup.appendChild(el('span', 'rg-filter-group-label', 'State'));
  stateGroup.appendChild(stateRow);

  const searchWrap = el('div', 'rg-search-wrap');
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'rg-search-input';
  searchInput.placeholder = 'Search name, provenance, detail...';
  searchInput.value = state.search; // restore a persisted search term across a rerender()
  searchWrap.appendChild(searchInput);

  filterBar.append(kindGroup, stateGroup, searchWrap);

  const tableHead = el('div', 'rg-row rg-row--head');
  tableHead.appendChild(el('span', 'rg-head-cell', 'Kind'));
  tableHead.appendChild(el('span', 'rg-head-cell', 'Name'));
  tableHead.appendChild(el('span', 'rg-head-cell', 'State'));
  tableHead.appendChild(el('span', 'rg-head-cell', 'Provenance'));
  tableHead.appendChild(el('span', 'rg-head-cell', 'Last used'));
  tableHead.appendChild(el('span', 'rg-head-cell', 'Actions'));

  const tableScroll = el('div', 'rg-table-scroll');
  const table = el('div', 'rg-table');
  table.appendChild(tableHead);
  tableScroll.appendChild(table);

  const pager = el('div', 'rg-pager');


  // "Push to agents" is a bulk action over every approved/trialing/kept
  // shared-memory fact (POST /api/cross-agent-memory/push), not a per-row
  // action, so it lives here as a toolbar button rather than inline on a
  // single row, mirroring memory.js's camHeader "Push to agents" button.
  //
  // glmps-138 fix pass (wave2-review.md Registry Minor #1): only build this
  // panel when GET /api/cross-agent-memory actually succeeded. Previously
  // this toolbar + a live "Push" button rendered unconditionally, so on any
  // failed fetch the operator saw an apparently-functional control that
  // could only error on click. Mirrors memory.js's renderSharedMemorySection,
  // which likewise never renders its header/button on a failed fetch.
  const camPanel = el('section', 'an-panel rg-cam-panel');
  if (camR.status === 'fulfilled') {
    camPanel.appendChild(el('h2', 'an-panel-title', 'Shared memory'));
    const camWrap = el('div', 'rg-actions');
    const camStatus = el('span', 'rg-row-status');
    camStatus.setAttribute('role', 'status');
    camStatus.setAttribute('aria-live', 'polite');
    const pushBtn = buildButton('Push approved facts to agents', 'save');
    wireAction(pushBtn, [pushBtn], camStatus, () => pushCrossAgentMemory(), rerender);
    camWrap.append(pushBtn, camStatus);
    camPanel.appendChild(camWrap);
  }

  function renderBody() {
    // Clear only the row list + pager (filter chips / search input keep
    // their DOM identity and focus across a filter change).
    while (table.children.length > 1) table.removeChild(table.lastChild);
    clear(pager);

    const q = state.search.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (!state.kinds.has(r.kind)) return false;
      if (!state.states.has(r.state)) return false;
      if (!q) return true;
      const hay = `${r.name} ${r.provenance ?? ''} ${r.detail ?? ''} ${r.subLabel ?? ''}`.toLowerCase();
      return hay.includes(q);
    });

    // Pagination is scoped to the memory kind ONLY (glmps-138 fix pass,
    // wave2-review.md Registry Important #1: the design spec calls for
    // "pagination or virtualized list for the high-volume memory kind" -
    // memory is the one kind with hundreds of proposals. Every other kind
    // (guard/skill/research-candidate/cross-agent-memory) always renders in
    // full, unpaginated, so a pending approval in any of those never gets
    // buried behind dozens of memory rows on a later page.
    const nonMemoryRows = opts.pageAll ? [] : filtered.filter((r) => r.kind !== 'memory');
    const memoryRows = opts.pageAll ? filtered : filtered.filter((r) => r.kind === 'memory');

    const memPageCount = Math.max(1, Math.ceil(memoryRows.length / PAGE_SIZE));
    if (state.page > memPageCount) state.page = memPageCount;
    const startIdx = (state.page - 1) * PAGE_SIZE;
    const memoryPageRows = memoryRows.slice(startIdx, startIdx + PAGE_SIZE);

    if (!filtered.length) {
      table.appendChild(el('div', 'an-empty rg-empty', 'No capabilities match the current filters.'));
    } else {
      for (const row of nonMemoryRows) table.appendChild(buildTableRow(row, rerender));
      for (const row of memoryPageRows) table.appendChild(buildTableRow(row, rerender));
    }

    const shown = nonMemoryRows.length + memoryPageRows.length;
    const pagingSuffix = memPageCount > 1 ? `, ${opts.pageAll ? 'page' : 'Memory page'} ${state.page} of ${memPageCount}` : '';
    const info = el('span', 'rg-pager-info',
      `${filtered.length} row${filtered.length === 1 ? '' : 's'} (${shown} shown${pagingSuffix})`);
    const prevBtn = el('button', 'rg-pager-btn', 'Prev');
    prevBtn.type = 'button';
    prevBtn.disabled = state.page <= 1;
    prevBtn.addEventListener('click', () => { state.page -= 1; renderBody(); });
    const nextBtn = el('button', 'rg-pager-btn', 'Next');
    nextBtn.type = 'button';
    nextBtn.disabled = state.page >= memPageCount;
    nextBtn.addEventListener('click', () => { state.page += 1; renderBody(); });
    pager.append(prevBtn, info, nextBtn);
  }

  function renderChips() {
    clear(kindRow);
    kindRow.appendChild(buildFilterChip('All kinds', state.kinds.size === KIND_ORDER.length, () => {
      if (state.kinds.size === KIND_ORDER.length) state.kinds.clear();
      else KIND_ORDER.forEach((k) => state.kinds.add(k));
      state.page = 1; renderChips(); renderBody();
    }));
    for (const group of CAPABILITY_KINDS) {
      const on = group.rowKinds.every((k) => state.kinds.has(k));
      kindRow.appendChild(buildFilterChip(group.label, on, () => {
        const allOn = group.rowKinds.every((k) => state.kinds.has(k));
        for (const k of group.rowKinds) { if (allOn) state.kinds.delete(k); else state.kinds.add(k); }
        state.page = 1; renderChips(); renderBody();
      }));
    }

    clear(stateRow);
    stateRow.appendChild(buildFilterChip('All states', state.states.size === STATE_ORDER.length, () => {
      if (state.states.size === STATE_ORDER.length) state.states.clear();
      else STATE_ORDER.forEach((s) => state.states.add(s));
      state.page = 1; renderChips(); renderBody();
    }));
    for (const st of STATE_ORDER) {
      stateRow.appendChild(buildFilterChip(stateLabel(st), state.states.has(st), () => {
        if (state.states.has(st)) state.states.delete(st); else state.states.add(st);
        state.page = 1; renderChips(); renderBody();
      }));
    }
  }

  searchInput.addEventListener('input', () => {
    state.search = searchInput.value;
    state.page = 1;
    renderBody();
  });

  renderChips();
  renderBody();
  _repaintFilters = () => { renderChips(); renderBody(); };

  // Tiled deck: the digest takes a wide 2-up cell (its values render in an
  // internal 2-column grid), and the short shared-memory action panel
  // sits in a narrow side column beside it. This
  // keeps the deck short so the list below inherits the remaining height,
  // instead of the tall digest setting the height of a full 3-across row.
  if (slots) {
    slots.memory?.appendChild(digestPanel);
    if (camPanel.children.length) slots.memory?.appendChild(camPanel);
  } else {
    const deck = el('div', 'rg-deck');
    deck.appendChild(digestPanel);
    const deckSide = el('div', 'rg-deck-side');
    if (camPanel.children.length) deckSide.appendChild(camPanel);
    deck.appendChild(deckSide);
    container.appendChild(deck);
  }

  // Lesson ledger (ADR-0001). Full-width and directly above the proposals
  // list, because the two answer adjacent questions - what landed, versus what
  // is proposed - and the boundary between them is only legible when they sit
  // together. It scrolls internally so the list below keeps its height.
  // The Evolution lens hosts the ledger in its file view; alone, it sits here.
  if (opts.lessonsHost) { clear(opts.lessonsHost); renderLessonLedger(opts.lessonsHost, lessonsData, rerender); }
  else renderLessonLedger(container, lessonsData, rerender);

  container.appendChild(filterBar);   // filters sit directly above the list they filter
  container.appendChild(tableScroll); // the capability list fills the rest of the view and scrolls internally
  container.appendChild(pager);
}
