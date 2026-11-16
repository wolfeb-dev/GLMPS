// server/lib/kernel/chain.js
// K7 (D6 borrow c): a card's chain is its prompt (intent), its declared plan
// (server/lib/scut/progress-store.js, written via POST /api/backlog/:id/progress),
// and its task class (server/lib/evaluation/task-classify.js). Pure over its
// inputs - no fs, no network - so the plan gate and the /chain route can share
// one definition of "what a card's chain is" without either one owning it.
export function cardChain({ item, progress, classify }) {
  return {
    id: item.id,
    intent: item.prompt ?? '',
    plan: progress?.[item.id]?.plan ?? null,
    taskClass: classify({ firstPrompt: item.prompt ?? '', filesTouched: [] }).taskClass,
    testEditsApproved: item.testEditsApproved ?? null,
    testEditsDeclared: item.testEditsDeclared ?? null,
  };
}
