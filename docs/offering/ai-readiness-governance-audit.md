# AI Readiness & Governance Audit — offering (GLMPS-powered)

- **Date:** 2026-07-01
- **Status:** Draft offering spec. Turns the "AI-enablement consulting for the mid-market"
  thesis into a fixed-scope, sellable engagement with GLMPS as the instrument.
- **Note:** built from first principles + the enterprise-AI storm-research findings + GLMPS's
  actual capabilities. The specific "AI Enablement job description" (authored separately) is the
  intended methodology spine — drop it in to align competencies/titles exactly.

## 1. The one-liner

**"In two weeks, a clear picture of every AI tool your engineers actually use, where your
sensitive data flows through them, where governance is missing — and a concrete plan to adopt AI
safely without slowing anyone down."**

For: **mid-market companies (≈50–500 people)** adopting AI coding tools with no visibility, no
governance, no strategy — and no platform team or budget to build one. They don't need Datadog;
they need a person with a method and a tool. That person is you.

## 2. Why it exists (the thesis, evidence-backed)

From the enterprise-AI research (see `storm-reports/enterprise-ai-implement-secure-protect-briefing.html`):
- Shadow AI via unmanaged personal accounts is the dominant data-leak; it bypasses file/email DLP.
- The binding constraint across adopting, securing, and proving ROI on AI is the same: **nobody is
  measuring what AI does with company data at the point of use.**
- Governance frameworks (NIST AI RMF, OWASP LLM Top 10, ISO 42001) exist but sit on paper; there is
  no evidence any of them reduces breaches without instrumentation.

Mid-market can't self-serve this. The competitive review (`storm-reports/glmps-adversarial-competitive-review.html`)
showed the platforms (Datadog/LangSmith/Braintrust) sell to orgs that already have observability
teams. The mid-market gap is **person-shaped**, and GLMPS's "weaknesses" as a product become assets
in a service: local + zero-config + on-prem = drops in with no procurement, no security review, no
"our data leaves the building" objection; zero-config cross-harness capture = a real baseline in an
afternoon, not a quarter.

## 3. Shape, scope, price

- **Format:** fixed-scope, fixed-fee engagement (not time-and-materials). ~**2–3 weeks**.
- **Tiers:**
  - **Audit (wedge):** assessment + baseline + roadmap. ~1–2 weeks. The land.
  - **Audit + Govern:** the above plus standing up guardrails/policy + the alert center on a
    sample/managed environment. ~3 weeks.
  - **Retainer (expand):** monthly monitoring + quarterly reviews + the learning loop, ongoing.
- **Price frame:** anchor on value (a single prevented source-code leak or a bad AI-tool standardization
  dwarfs the fee), not hours. Fixed audit fee + retainer. (Set numbers to your market.)

## 4. The engagement — 4 phases

Each phase names the activity, **what GLMPS produces**, and the **client deliverable**.

### Phase 1 — Assess (the wedge)
- **Do:** `glmps init` on a representative sample of dev machines and/or the managed dev environment
  (Codespaces/Coder/base image). Capture 3–5 days of real sessions across whatever harnesses they use
  (Claude Code, Copilot, Codex, Cursor, Gemini CLI, Cline…). Point OTel-emitting tools at the GLMPS
  OTLP receiver for extra coverage.
- **GLMPS produces:** capture-parity coverage matrix (which tools, how completely captured), the
  session map with dev/prod zones, usage/cost, and the alert center's first flags (injection/egress/
  poison-quarantine).
- **Deliverable:** **AI Usage & Risk Baseline** — the report in §5.

### Phase 2 — Govern
- **Do:** turn on and tune the guardrails: dev/prod zone classification, sensitive-data-egress and
  injection detection, the live-install/write guards; draft an AI-use policy; recommend contractual
  controls (no-train clauses, data-retention, tenant isolation) for their AI vendors.
- **GLMPS produces:** the running alert center + a governance-gap list mapped to NIST AI RMF / OWASP
  LLM Top 10 sections (so the client sees standards coverage, not just tool output).
- **Deliverable:** **Governance Starter Kit** — policy template, guardrail config, the standards
  gap-map, and a prioritized remediation list.

### Phase 3 — Enable
- **Do:** "govern-don't-ban" playbook — pick and stand up a sanctioned, equally-fast AI path so people
  stop defecting to personal accounts; light training; wire the capability learning loop so misuse is
  caught over time, not once.
- **Deliverable:** **AI Adoption Playbook** — sanctioned-tool decision, the fast-path setup, a short
  team enablement guide, and the measurement plan.

### Phase 4 — Measure (retainer)
- **Do:** monthly monitoring + quarterly reviews; track sensitive-paste/egress rate, AI-related
  incidents, adoption, and the guard-efficacy loop (did a guard reduce the gap it targeted).
- **Deliverable:** **Quarterly AI Posture Review** — trend vs baseline, new risks, next actions.

## 5. The headline deliverable: AI Usage & Risk Baseline (report outline)

1. **Executive summary** — what AI is in use, the 3 biggest risks, the 3 highest-leverage moves.
2. **AI tool inventory** — every harness detected + the capture-coverage confidence per tool (from the
   parity matrix), incl. shadow/unsanctioned usage.
3. **Sensitive-data exposure** — where secret/prod-zone content was touched by agents (egress findings),
   with the file-access-layer detail platforms can't see.
4. **Injection / poisoning exposure** — flagged patterns in ingested content (labelled "review", with
   the calibration caveat stated honestly).
5. **Governance gap-map** — current state vs NIST AI RMF / OWASP LLM Top 10 / ISO 42001, RAG/agent
   attack surface, contractual gaps.
6. **Roadmap** — prioritized, sequenced, tied to the "measure-before-govern / point-of-use enforcement /
   contract-before-connect" moves from the research.

## 6. Feature → deliverable map (why GLMPS makes this fast + credible)

| GLMPS capability | Feeds |
|---|---|
| `glmps init` + adapters + OTel bridge | Phase 1 capture across harnesses, on-prem, zero-config |
| Capture-parity coverage matrix | Tool inventory + honest capture-confidence per tool |
| Zones (dev/prod) + egress detector | Sensitive-data exposure section |
| Injection detector (poison-scan) | Injection/poisoning section (review-grade) |
| Alert center | The live artifact the client keeps running |
| Learning/guardrails loop | Phase 3–4 misuse-over-time + measurement |
| Portability chassis (engagement profile, three-tier, observe/act) | The engagement scaffolding itself |
| Storm-research best-practices | The strategy/roadmap spine |

## 7. Positioning (from the competitive review)

- **Not** an observability platform (that's Datadog/LangSmith's fight — you lose on funding/scale).
- **Not** fleet-wide monitoring (coverage = your sample/managed-env reach; name the blind spot).
- **You are** the local, cross-harness, on-prem **governance + strategy** engagement — the person +
  method + tool a mid-market company can't hire or buy off the shelf.
- Objection "why not Copilot's own dashboard?" → single-vendor, no cross-harness, no governance/zone
  layer, no strategy, no on-prem baseline.

## 8. Honest boundaries (say these up front)

- It's a **services** business — your time is the product; the tool is the multiplier. A practice, not
  a rocket. (Later: license the kit to other enablement consultants, or a light retainer SaaS.)
- Coverage = where you can deploy `glmps init` (sample machines / managed env), **not** every laptop.
  Truly unmanaged/BYOD is a permanent blind spot — you map it, you don't pretend to close it.
- The injection detector is uncalibrated (review-grade, not block-grade) until the labelled eval set
  from `glmps-self-improvement-loop` exists — state that in the report; don't oversell precision.

## 9. Path to launch (what to build to make this sellable)

1. **Deliverable templates** — the AI Usage & Risk Baseline report template + the Governance Starter
   Kit + the Playbook (so delivery is repeatable, not bespoke each time). *Next build.*
2. **`glmps init` client-drop packaging** — a clean, safe, time-boxed capture mode for a client
   environment (read-only, auto-expiring, easy uninstall) + a one-page "what it collects / where data
   stays (local)" so it clears their security review in minutes.
3. **A GLMPS "report export"** — turn the live dashboard state into the baseline report artifact
   (extend the storm-report HTML style) so the deliverable is generated, not hand-written.
4. **One pilot** — run the audit for a friendly mid-market company at cost, to produce a reference case
   + sharpen the templates. The reference case is the real sales asset.
5. **The one-pager + a 20-min demo script** — the sales collateral (this doc's §1–3 condensed).

## 10. Open input needed

- The specific **AI Enablement job description** to align the competency/role language and make the
  offering read as "the role you'd hire, delivered as a service."
- Target market + price points (to set the tiers in §3).
