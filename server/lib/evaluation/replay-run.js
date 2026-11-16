/**
 * Headless replay re-run driver.
 * Fully injectable: pass `launch` and `buildOutcome` for testing.
 *
 * @param {string} stateDir
 * @param {object} task
 * @param {{
 *   launch?: (task: object) => Promise<object|null>,
 *   buildOutcome?: (input: object) => object,
 *   model?: string|null,
 *   unit?: string,
 * }} [opts] - `model`/`unit`, when provided, stamp the produced row after
 *   buildOutcome runs, letting a model-swap replay tag its cohort (e.g.
 *   unit 'model-claude-sonnet-5') without changing launch mechanics.
 */
export async function runReplay(stateDir, task, { launch, buildOutcome, model, unit } = {}) {
  if (!launch) {
    // Real headless path (glmps-68). runReplayTask appends its own row, so the
    // default buildOutcome passes that row straight through. (The previous
    // default imported a runQueuedTask export that never existed - this was
    // the data-gated wiring Phase 2 left open.)
    const { runReplayTask } = await import('./replay-launch.js');
    launch = async (t) => (await runReplayTask({ stateDir, task: t, model: model ?? null })).row;
    if (!buildOutcome) buildOutcome = (row) => row;
  }

  if (!buildOutcome) {
    const { buildSessionOutcome } = await import('./session-outcome.js');
    buildOutcome = buildSessionOutcome;
  }

  let launchResult;
  try {
    launchResult = await launch(task);
  } catch {
    return { produced: null };
  }

  if (!launchResult) {
    return { produced: null };
  }

  const row = buildOutcome(launchResult);
  if (model !== undefined) row.model = model;
  if (unit !== undefined) row.unit = unit;
  return { produced: row };
}
