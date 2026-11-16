# Skill cues

The operator's words for the Matt Pocock engineering skills. When a card or a
Slack reply uses a phrase below, that skill is the one to run, and agents use
these skill names when they say what they ran. The queue runner reads both
tables from this file (card glmps-2-0-110); edit them here and nowhere else.

Every phrase here is an instruction, so naming a thing ("the research scan",
"wakeHandoff", "the triage labels") never cues it; only asking for the skill
does. Phrases are matched case-insensitively on word boundaries; a hyphen and a
space are interchangeable inside a phrase, but a hyphen or dot joined to its
first or last word ("data-research", "spec-it.md") is part of a name, not a cue.

## Cue phrases

| Skill | Phrases | Means |
|---|---|---|
| grill-me | grill me, grill this, grill it, poke holes in this, stress-test this, /grill-me | Interview the operator until the plan is shared, one round of numbered questions at a time. |
| grill-with-docs | grill with docs, grill and document, /grill-with-docs | The same interview, writing glossary terms and ADRs as they settle. |
| to-spec | spec it, spec this, spec it out, spec this out, write a spec, write the spec, /to-spec | Turn what has been agreed into a spec on the board. |
| to-tickets | ticket it, ticket this, break it into tickets, break this into tickets, /to-tickets | Split a spec or plan into tracer-bullet cards with blocking edges. |
| implement | implement the tickets, build the tickets, /implement | Build from a set of cards. |
| implement-spec | implement the spec, build the spec, /implement-spec | Build what to-spec and to-tickets produced. |
| tdd | do it test-first, build it test-first, write it test-first, red-green-refactor, /tdd | Write the failing test before the code. |
| diagnosing-bugs | diagnose this, diagnose it, debug this, find the root cause, /diagnose | Reproduce, minimise and explain a bug or regression before fixing it. |
| code-review | review the diff, review the branch, review this pr, review my changes, /code-review | Review changes against the repo's standards and the card's spec. |
| domain-modeling | build a glossary, update the glossary, sharpen the terminology, align the terminology, /domain-modeling | Settle what words mean and write them down. |
| codebase-design | design the module, deepen this module, find the seam, /codebase-design | Design or deepen one module's interface. |
| improve-codebase-architecture | improve the architecture, find deepening opportunities, /improve-codebase-architecture | Scan the codebase for deepening opportunities and grill through one. |
| prototype | prototype it, prototype this, build a throwaway, spike it, /prototype | Build something disposable to answer a design question. |
| research | research this, research it, look into this, /research | Investigate against primary sources and write the findings down. |
| triage | /triage | Sort incoming cards and PRs, verify them, grill where needed. |
| wayfinder | map the work, use wayfinder, too big for one session, /wayfinder | Plan work bigger than one session as a map of decision cards. |
| handoff | hand this off, hand it off, write a handoff, /handoff | Compact the session into a document another agent can pick up. |

## Operator words

Single words the operator uses as requests. They count only in text the
operator wrote (a card filed from Slack, or a reply in its thread), because
agent-written cards use the same words as names ("the research scanner",
"triage card glmps-2-0-75"). Measured on the board on 2026-10-27: "research"
was a request in 10 of 11 operator cards and 0 of 24 agent cards; "triage" in
2 of 2 and 0 of 28.

| Skill | Words | Means |
|---|---|---|
| research | research, deep research | Investigate against primary sources and write the findings down. |
| triage | triage | Sort incoming cards and PRs, verify them, grill where needed. |

## Default by card class

When nothing above matches, the card's class picks one skill as a suggestion.
A `-` means no class skill: the routed agent already is the method. Review
cards get none because the routed `code-critic` agent is the review; the
`code-review` suggestion was used on 0 of 10 review cards (card glmps-2-0-185).

| Card class | Skill |
|---|---|
| debug | diagnosing-bugs |
| feature | tdd |
| refactor | codebase-design |
| ops | implement |
| review | - |
| docs | to-spec |
| research | research |
| ui | prototype |
| other | grill-me |
