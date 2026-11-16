/**
 * @fileoverview AI Usage & Risk Baseline - HTML report renderer.
 *
 * Pure module: no side effects, no Date.now() / new Date(), no imports from
 * other project modules.  Call renderBaselineReport(data) and receive a
 * self-contained HTML string suitable for saving as .html or printing.
 */

// JSDoc types

/**
 * @typedef {Object} ToolEntry
 * @property {string} id
 * @property {string} displayName
 * @property {number} popularityWeight - 1-5 signal strength
 * @property {string} captureSurface - e.g. 'local-artifact', 'network'
 * @property {boolean} hasAdapter
 * @property {boolean} reference - true = the reference tool (e.g. Claude Code)
 */

/**
 * @typedef {Object} CoverageData
 * @property {string} reference             - id of the reference tool
 * @property {ToolEntry[]} tools
 * @property {number} covered               - count of tools with an adapter
 * @property {string[]} uncovered           - ids of tools without an adapter
 */

/**
 * @typedef {Object} EgressFinding
 * @property {string} sessionId
 * @property {string} path                  - file path that triggered the finding
 * @property {string} reason                - human-readable description
 * @property {string} severity              - 'critical' | 'warn' | 'info'
 * @property {string|null} kind
 */

/**
 * @typedef {Object} InjectionFinding
 * @property {string} sessionId
 * @property {string} code                  - detector pattern code
 * @property {string} severity              - 'critical' | 'warn' | 'info'
 * @property {string} sample               - short excerpt of flagged content
 * @property {string|null} kind
 * @property {string|null} tool
 */

/**
 * @typedef {Object} Alert
 * @property {string} id
 * @property {string} source
 * @property {string} severity
 * @property {string} title
 * @property {string} detail
 */

/**
 * @typedef {Object} RoadmapItem
 * @property {string} priority              - 'High' | 'Medium' | 'Low'
 * @property {string} action
 * @property {string} [rationale]
 */

/**
 * @typedef {Object} ReportData
 * @property {string} generatedAt                    - ISO timestamp set by the caller
 * @property {{ name?: string }} [client]            - optional client identity
 * @property {CoverageData} coverage
 * @property {{ total:number, byTool:Record<string,number> }} [sessions]
 * @property {EgressFinding[]} egress
 * @property {InjectionFinding[]} injection
 * @property {Alert[]} alerts
 * @property {RoadmapItem[]} [roadmap]
 */

// Constants

const DEFAULT_ROADMAP = [
  {
    priority: 'High',
    action: 'Establish a sanctioned AI tool policy and require procurement review before new tools are added.',
    rationale: 'Measure before governing.',
  },
  {
    priority: 'High',
    action: 'Enable and tune the sensitive-data egress detector for dev/prod zone boundaries.',
    rationale: 'Point-of-use enforcement.',
  },
  {
    priority: 'High',
    action: 'Add no-training and data-retention clauses to AI vendor contracts.',
    rationale: 'Contract before connecting.',
  },
  {
    priority: 'Medium',
    action: 'Build capture adapters for uncaptured AI tools to close coverage gaps.',
    rationale: 'Coverage = visibility.',
  },
  {
    priority: 'Medium',
    action: 'Tune the injection detector with a labeled eval set to reduce false-positive rate.',
    rationale: 'Calibrate review-grade flags before promoting to block.',
  },
  {
    priority: 'Low',
    action: 'Stand up a quarterly AI posture review cadence using GLMPS data as the baseline.',
    rationale: 'Sustain via measurement.',
  },
];

// Helpers

/**
 * HTML-escape every character that can break out of an attribute or text node.
 * @param {unknown} v
 * @returns {string}
 */
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Return the basename of a file path (platform-agnostic).
 * @param {string} p
 * @returns {string}
 */
function basename(p) {
  return String(p ?? '').replace(/\\/g, '/').split('/').pop() ?? p;
}

/**
 * Severity chip HTML.
 * @param {string} sev
 * @returns {string}
 */
function severityChip(sev) {
  const s = String(sev ?? '').toLowerCase();
  const color = s === 'critical' ? 'chip-red' : s === 'warn' || s === 'warning' ? 'chip-amber' : 'chip-green';
  return `<span class="chip ${color}">${esc(sev)}</span>`;
}

/**
 * Priority chip HTML.
 * @param {string} pri
 * @returns {string}
 */
function priorityChip(pri) {
  const p = String(pri ?? '').toLowerCase();
  const color = p === 'high' ? 'chip-red' : p === 'medium' ? 'chip-amber' : 'chip-green';
  return `<span class="chip ${color}">${esc(pri)}</span>`;
}

/**
 * Section header with a numbered blue circle.
 * @param {number} n
 * @param {string} title
 * @returns {string}
 */
function sectionHeader(n, title) {
  return `<div class="section-header"><span class="section-num">${n}</span><h2>${esc(title)}</h2></div>`;
}

// Section renderers

function renderStyles() {
  return `<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #ffffff;
    --text: #0f172a;
    --muted: #64748b;
    --accent: #2563eb;
    --red: #dc2626;
    --amber: #d97706;
    --green: #15803d;
    --border: #e2e8f0;
    --th-bg: #f1f5f9;
    --sp: 1rem;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 15px;
    color: var(--text);
    background: var(--bg);
  }
  body { padding: 2rem; max-width: 960px; margin: 0 auto; }
  h1 { font-size: 2rem; font-weight: 700; color: var(--accent); }
  h2 { font-size: 1.15rem; font-weight: 600; }
  h3 { font-size: 1rem; font-weight: 600; margin-bottom: .5rem; }
  p  { line-height: 1.6; }
  a  { color: var(--accent); }

  .cover { border-bottom: 3px solid var(--accent); padding-bottom: 2rem; margin-bottom: 2rem; }
  .cover-meta { color: var(--muted); font-size: .85rem; margin-top: .35rem; }
  .stats-row { display: flex; gap: 1rem; margin-top: 1.5rem; flex-wrap: wrap; }
  .stat-card {
    flex: 1 1 160px;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem 1.25rem;
  }
  .stat-card .stat-num { font-size: 2rem; font-weight: 700; color: var(--accent); }
  .stat-card .stat-label { font-size: .8rem; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; margin-top: .2rem; }

  .section { margin: 2.5rem 0; }
  .section-header { display: flex; align-items: center; gap: .75rem; margin-bottom: 1.25rem; }
  .section-num {
    display: inline-flex; align-items: center; justify-content: center;
    width: 2rem; height: 2rem; border-radius: 50%;
    background: var(--accent); color: #fff; font-size: .85rem; font-weight: 700;
    flex-shrink: 0;
  }

  table { width: 100%; border-collapse: collapse; font-size: .875rem; }
  thead th {
    background: var(--th-bg); text-align: left; padding: .55rem .75rem;
    font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted);
    border-bottom: 1px solid var(--border);
  }
  tbody td { padding: .55rem .75rem; border-bottom: 1px solid var(--border); vertical-align: top; }
  tbody tr:last-child td { border-bottom: none; }
  .empty-row td { color: var(--muted); font-style: italic; text-align: center; }

  .chip {
    display: inline-block; padding: .15em .55em; border-radius: 4px;
    font-size: .75rem; font-weight: 600; letter-spacing: .02em;
  }
  .chip-red    { background: #fee2e2; color: var(--red); }
  .chip-amber  { background: #fef3c7; color: var(--amber); }
  .chip-green  { background: #dcfce7; color: var(--green); }
  .chip-blue   { background: #dbeafe; color: var(--accent); }

  .risks-moves { display: flex; gap: 1.5rem; flex-wrap: wrap; }
  .risks-moves > div { flex: 1 1 300px; }
  .risks-moves ul { padding-left: 1.2rem; }
  .risks-moves li { margin: .5rem 0; line-height: 1.5; }

  .gap-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; }
  .gap-card { border: 1px solid var(--border); border-radius: 8px; padding: 1rem; }
  .gap-card h3 { color: var(--accent); font-size: .9rem; }
  .gap-card ul { list-style: none; padding: 0; margin-top: .5rem; }
  .gap-card li { padding: .25rem 0; font-size: .825rem; color: var(--muted); border-bottom: 1px dashed var(--border); }
  .gap-card li:last-child { border-bottom: none; }

  .caveat {
    background: #fefce8; border-left: 4px solid var(--amber);
    padding: .75rem 1rem; border-radius: 0 6px 6px 0;
    font-size: .85rem; line-height: 1.6; margin-bottom: 1.25rem; color: var(--text);
  }

  .footer {
    margin-top: 3rem; padding-top: 1.25rem; border-top: 1px solid var(--border);
    font-size: .8rem; color: var(--muted); line-height: 1.7;
  }
  .footer strong { color: var(--text); }

  @media print {
    body { padding: .5rem; font-size: 12px; }
    .stat-card { page-break-inside: avoid; }
    .section { page-break-inside: avoid; }
    .gap-grid { grid-template-columns: repeat(2, 1fr); }
  }
</style>`;
}

/**
 * @param {ReportData} data
 * @returns {string}
 */
function renderCover(data) {
  const coverage = data.coverage ?? { tools: [], covered: 0, uncovered: [] };
  const sessions = data.sessions ?? { total: 0 };
  const egress = data.egress ?? [];
  const injection = data.injection ?? [];
  const tools = coverage.tools ?? [];
  const adaptersCount = tools.filter(t => t.hasAdapter).length;
  const clientName = data.client?.name;

  return `<div class="cover">
  <h1>AI Usage &amp; Risk Baseline</h1>
  ${clientName ? `<p class="cover-meta">Prepared for: <strong>${esc(clientName)}</strong></p>` : ''}
  <p class="cover-meta">Generated: ${esc(data.generatedAt ?? '')}</p>
  <div class="stats-row">
    <div class="stat-card">
      <div class="stat-num">${esc(sessions.total ?? 0)}</div>
      <div class="stat-label">Sessions Captured</div>
    </div>
    <div class="stat-card">
      <div class="stat-num">${esc(adaptersCount)}</div>
      <div class="stat-label">Tools with Adapters</div>
    </div>
    <div class="stat-card">
      <div class="stat-num">${esc(egress.length)}</div>
      <div class="stat-label">Egress Findings</div>
    </div>
    <div class="stat-card">
      <div class="stat-num">${esc(injection.length)}</div>
      <div class="stat-label">Injection Flags</div>
    </div>
  </div>
</div>`;
}

/**
 * @param {ReportData} data
 * @param {RoadmapItem[]} effectiveRoadmap
 * @returns {string}
 */
function renderExecSummary(data, effectiveRoadmap) {
  const coverage = data.coverage ?? { uncovered: [] };
  const egress = data.egress ?? [];
  const injection = data.injection ?? [];

  const criticalEgress = egress.filter(e => e.severity === 'critical').length;
  const criticalInjection = injection.filter(i => i.severity === 'critical').length;
  const uncoveredCount = (coverage.uncovered ?? []).length;
  const warnEgress = egress.filter(e => e.severity === 'warn' || e.severity === 'warning').length;

  const risks = [];
  if (criticalEgress > 0) {
    risks.push(`${criticalEgress} critical sensitive-data egress finding${criticalEgress > 1 ? 's' : ''} detected \u2014 potential data-boundary violation.`);
  }
  if (criticalInjection > 0) {
    risks.push(`${criticalInjection} critical injection/poisoning flag${criticalInjection > 1 ? 's' : ''} \u2014 prompt-injection risk in active sessions.`);
  }
  if (uncoveredCount > 0) {
    risks.push(`${uncoveredCount} AI tool${uncoveredCount > 1 ? 's' : ''} lack capture adapters \u2014 blind spots in usage visibility.`);
  }
  if (warnEgress > 0 && risks.length < 3) {
    risks.push(`${warnEgress} warn-level egress finding${warnEgress > 1 ? 's' : ''} require human review.`);
  }
  const genericRisks = [
    'No sanctioned AI tool policy observed \u2014 tools may be added without security review.',
    'AI vendor data-retention and no-training clauses may not be in place.',
    'Injection detector is uncalibrated; block-grade enforcement is not yet operational.',
  ];
  for (const g of genericRisks) {
    if (risks.length >= 3) break;
    risks.push(g);
  }
  const topRisks = risks.slice(0, 3);
  const topMoves = effectiveRoadmap.slice(0, 3).map(r => r.action);

  const riskItems = topRisks.map(r => `<li>${esc(r)}</li>`).join('');
  const moveItems = topMoves.map(m => `<li>${esc(m)}</li>`).join('');

  return `<div class="section">
  ${sectionHeader(1, 'Executive Summary')}
  <div class="risks-moves">
    <div>
      <h3>Top Risks</h3>
      <ul>${riskItems}</ul>
    </div>
    <div>
      <h3>Top Moves</h3>
      <ul>${moveItems}</ul>
    </div>
  </div>
</div>`;
}

/**
 * @param {ReportData} data
 * @returns {string}
 */
function renderToolInventory(data) {
  const tools = (data.coverage?.tools ?? []);

  const rows = tools.map(t => {
    const captureChip = t.hasAdapter
      ? `<span class="chip chip-green">Captured</span>`
      : `<span class="chip chip-amber">No adapter</span>`;
    const pop = Math.min(5, Math.max(0, Math.round(t.popularityWeight ?? 0)));
    return `<tr>
      <td>${esc(t.displayName)}</td>
      <td><code>${esc(t.id)}</code></td>
      <td>${esc(pop)}&nbsp;/&nbsp;5</td>
      <td>${captureChip}</td>
      <td>${esc(t.captureSurface)}</td>
    </tr>`;
  });

  const body = rows.length
    ? rows.join('')
    : `<tr class="empty-row"><td colspan="5">No tools in inventory</td></tr>`;

  return `<div class="section">
  ${sectionHeader(2, 'AI Tool Inventory')}
  <table>
    <thead><tr>
      <th>Tool</th><th>ID</th><th>Popularity</th><th>Capture</th><th>Surface</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>
</div>`;
}

/**
 * @param {ReportData} data
 * @returns {string}
 */
function renderEgress(data) {
  const findings = data.egress ?? [];

  const rows = findings.map(f => {
    return `<tr>
      <td>${severityChip(f.severity)}</td>
      <td>${esc(basename(f.path))}</td>
      <td>${esc(f.reason)}</td>
      <td><code>${esc(f.sessionId)}</code></td>
    </tr>`;
  });

  const body = rows.length
    ? rows.join('')
    : `<tr class="empty-row"><td colspan="4">No egress findings detected</td></tr>`;

  return `<div class="section">
  ${sectionHeader(3, 'Sensitive-Data Exposure')}
  <table>
    <thead><tr>
      <th>Severity</th><th>File</th><th>Reason</th><th>Session</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>
</div>`;
}

/**
 * @param {ReportData} data
 * @returns {string}
 */
function renderInjection(data) {
  const findings = data.injection ?? [];

  const rows = findings.map(f => {
    return `<tr>
      <td>${severityChip(f.severity)}</td>
      <td><code>${esc(f.sessionId)}</code></td>
      <td><code>${esc(f.code)}</code></td>
      <td style="max-width:280px;word-break:break-word;font-size:.8rem;">${f.code === 'credential' ? '<em>redacted</em>' : esc(f.sample)}</td>
    </tr>`;
  });

  const body = rows.length
    ? rows.join('')
    : `<tr class="empty-row"><td colspan="4">No injection flags detected</td></tr>`;

  return `<div class="section">
  ${sectionHeader(4, 'Injection / Poisoning Exposure')}
  <div class="caveat">
    <strong>Calibration note:</strong> These are review-grade heuristic flags, not block-grade detections.
    The detector can over-fire on sessions whose content is legitimately about security work or this codebase.
    Treat hits as prompts for human review, not confirmed incidents.
  </div>
  <table>
    <thead><tr>
      <th>Severity</th><th>Session</th><th>Pattern</th><th>Sample</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>
</div>`;
}

/**
 * @returns {string}
 */
function renderGapMap() {
  const cards = [
    {
      title: 'NIST AI RMF',
      items: [
        'Govern: AI policy, roles, and accountability defined',
        'Map: AI use-cases inventoried and risk-tiered',
        'Measure: Evaluation metrics and monitoring in place',
        'Manage: Incident response procedure for AI failures',
      ],
    },
    {
      title: 'OWASP LLM Top 10',
      items: [
        'LLM01: Prompt injection controls reviewed',
        'LLM02: Insecure output handling mitigated',
        'LLM06: Sensitive information disclosure assessed',
        'LLM08: Excessive agency / autonomy guardrails set',
        'LLM09: Overreliance on AI outputs documented',
      ],
    },
    {
      title: 'ISO 42001',
      items: [
        'AI management system scope defined',
        'AI risk assessment process established',
        'Transparency and explainability obligations met',
        'Human oversight mechanisms documented',
        'Continual improvement cadence established',
      ],
    },
    {
      title: 'RAG / Agent Attack Surface',
      items: [
        'Retrieval corpus access controls reviewed',
        'Tool-call scope and permissions minimized',
        'Memory / context persistence boundaries set',
        'Agent-to-agent trust chain documented',
        'Sandboxing for code-execution tools in place',
      ],
    },
  ];

  const cardHtml = cards.map(c => {
    const items = c.items.map(i => `<li>&#9675; ${esc(i)}</li>`).join('');
    return `<div class="gap-card"><h3>${esc(c.title)}</h3><ul>${items}</ul></div>`;
  }).join('');

  return `<div class="section">
  ${sectionHeader(5, 'Governance Gap-Map')}
  <p style="margin-bottom:1rem;color:var(--muted);font-size:.875rem;">Checklist scaffold \u2014 items are prompts for the engagement conversation, not automated detections. Mark &#9679; (in place) / &#9651; (partial) / &#9675; (gap) during review.</p>
  <div class="gap-grid">${cardHtml}</div>
</div>`;
}

/**
 * @param {RoadmapItem[]} roadmap
 * @returns {string}
 */
function renderRoadmap(roadmap) {
  const rows = roadmap.map((item, i) => {
    return `<tr>
      <td style="font-weight:600;text-align:center;">${i + 1}</td>
      <td>${priorityChip(item.priority)}</td>
      <td>${esc(item.action)}</td>
      <td style="color:var(--muted);font-size:.825rem;">${esc(item.rationale ?? '')}</td>
    </tr>`;
  });

  return `<div class="section">
  ${sectionHeader(6, 'Roadmap')}
  <table>
    <thead><tr>
      <th style="width:3rem;">#</th><th>Priority</th><th>Action</th><th>Rationale</th>
    </tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>
</div>`;
}

/**
 * @returns {string}
 */
function renderFooter() {
  return `<div class="footer">
  <strong>Honest boundaries</strong><br>
  <strong>Services engagement:</strong> Time with your team is the product. This report is a structured starting point, not a finished compliance artefact. Findings require human judgment before any remediation decision.<br>
  <strong>Coverage scope:</strong> Capture reflects sessions that ran through instrumented tooling during the engagement window. It does not represent every AI interaction on every device in the organisation.<br>
  <strong>Injection detector:</strong> The detector is uncalibrated heuristic tooling. It has not been validated against a labeled eval set. All flags are review-grade only and must not be used as evidence of confirmed incidents without human investigation.<br>
  <strong>Not legal or compliance advice:</strong> Nothing in this report constitutes legal, regulatory, or certified compliance advice. Engage qualified legal counsel for GDPR, HIPAA, or sector-specific requirements.
</div>`;
}

// Main export

/**
 * Render a complete self-contained HTML report from the given baseline data.
 *
 * @param {ReportData} [data={}]
 * @returns {string} A complete HTML document string.
 */
export function renderBaselineReport(data = {}) {
  const effectiveRoadmap = (data.roadmap && data.roadmap.length > 0) ? data.roadmap : DEFAULT_ROADMAP;

  const body = [
    renderCover(data),
    renderExecSummary(data, effectiveRoadmap),
    renderToolInventory(data),
    renderEgress(data),
    renderInjection(data),
    renderGapMap(),
    renderRoadmap(effectiveRoadmap),
    renderFooter(),
  ].join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Usage &amp; Risk Baseline${data.client?.name ? ` \u2014 ${esc(data.client.name)}` : ''}</title>
${renderStyles()}
</head>
<body>
${body}
</body>
</html>`;
}
