// server/lib/scut/presence.js
// Presence/ack for SCUT: a reaction lifecycle on the mention message so a human
// (often AFK) knows their @mention was SEEN, and whether the agent is DONE or
// FAILED - the cheapest useful "is it working?" signal for a chat surface.
//   receipt -> :eyes:  (added the instant the mention lands)
//   done    -> swap :eyes: for :white_check_mark:
//   failed  -> swap :eyes: for :x:
// Best-effort: reaction errors (already_reacted, no_reaction, missing scope) are
// swallowed so presence never breaks routing. Reactions target ctx.ts (the
// mention message itself), not the thread.

const DEFAULT_EMOJI = { receipt: 'eyes', done: 'white_check_mark', failed: 'x' };

export function makePresence(web, { emoji = DEFAULT_EMOJI } = {}) {
  const add = async (ctx, name) => {
    try { await web.reactionsAdd({ channel: ctx.channel, timestamp: ctx.ts, name }); } catch { /* best-effort */ }
  };
  const remove = async (ctx, name) => {
    try { await web.reactionsRemove({ channel: ctx.channel, timestamp: ctx.ts, name }); } catch { /* best-effort */ }
  };
  return {
    receipt: (ctx) => add(ctx, emoji.receipt),
    done: async (ctx) => { await remove(ctx, emoji.receipt); await add(ctx, emoji.done); },
    failed: async (ctx) => { await remove(ctx, emoji.receipt); await add(ctx, emoji.failed); },
  };
}
