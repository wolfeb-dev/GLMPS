// server/lib/scut/ticket-visibility.js
// D27 close-and-hide, the Slack half. Hide: post the closing summary, rename
// the channel with a closed- prefix, remove the operators. The bot stays a
// member, so the channel still delivers replies and stays searchable.
// Unhide: invite the operators back, restore the name. The client is
// injected (slack-web.js), so the order of calls is testable.
import { hiddenChannelName } from './ticket-channel-ops.js';

const code = (e) => e?.code ?? null;

async function membersOf(web, channel) {
  const out = [];
  let cursor = null;
  do {
    const r = await web.conversationsMembers({ channel, cursor });
    out.push(...(r?.members ?? []));
    cursor = r?.response_metadata?.next_cursor || null;
  } while (cursor);
  return out;
}

// name_taken used to be swallowed unconditionally, so a
// GENUINE collision (some unrelated channel already holds the target name)
// still returned success and claimed a rename that never happened. Confirmed
// against conversations.info instead of assumed: tolerated only when the
// channel already carries the exact target name (this call's own retry, or
// a duplicate delivery), a named `rename_not_confirmed` error otherwise so
// reportMiss fires and the caller never believes a rename that did not land.
async function renameOrConfirm(web, channel, name) {
  try {
    await web.conversationsRename({ channel, name });
  } catch (e) {
    if (code(e) !== 'name_taken') throw e;
    // Phase C final review, M3: keep the info call's OWN error (if the
    // confirming call itself fails) in the thrown reason - "the channel
    // does not already carry it" reads as a confirmed mismatch, not as "the
    // confirming call could not even be made", and those are different
    // causes for an operator to chase.
    let info = null; let infoError = null;
    try { info = await web.conversationsInfo({ channel }); } catch (e2) { infoError = e2; }
    if (info?.channel?.name === name) return;
    const detail = infoError ? ` (conversations.info failed: ${code(infoError) ?? infoError?.message ?? infoError})` : '';
    const err = new Error(`rename of ${channel} to ${name} was refused (name_taken) and the channel does not already carry it${detail}`);
    err.code = 'rename_not_confirmed';
    throw err;
  }
}

// `main` ({ channel, thread_ts, text }, card glmps-2-0-104) is the copy for the
// ticket's original thread in the operator's channel, broadcast so it shows in
// the channel too. It posts once the rename is confirmed, so a hide that fails
// earlier and is retried never posts it twice, and its own failure never
// stops the hide: it comes back as `mainError` for the caller to log.
export async function hideTicketChannel({ web, entry, operatorIds = [], summary, main = null, onRenamed = null }) {
  // No summary: a card that closed long ago is hidden quietly (card glmps-2-0-85).
  if (summary) await web.chatPostMessage({ channel: entry.channelId, text: summary });
  const renamedTo = hiddenChannelName(entry.name ?? entry.channelId);
  await renameOrConfirm(web, entry.channelId, renamedTo);
  // the caller (server.js) marks the ticket-channel
  // store hidden from THIS callback, right after the rename is confirmed -
  // not after the whole sequence below succeeds. A kick failing afterward
  // must never leave the store claiming a visible channel that Slack
  // already shows renamed (and partially emptied) forever; unhide is
  // idempotent, so a later reopen still heals a partial hide.
  await onRenamed?.();
  let mainError = null;
  if (main?.channel && main?.thread_ts && main?.text) {
    try {
      await web.chatPostMessage({ channel: main.channel, thread_ts: main.thread_ts, reply_broadcast: true, text: main.text });
    } catch (e) { mainError = e; }
  }
  const members = new Set(await membersOf(web, entry.channelId));
  const kicked = [];
  for (const user of operatorIds) {
    if (!members.has(user)) continue;
    try { await web.conversationsKick({ channel: entry.channelId, user }); kicked.push(user); }
    catch (e) { if (code(e) !== 'not_in_channel' && code(e) !== 'cant_kick_self') throw e; }
  }
  return mainError ? { renamedTo, kicked, mainError } : { renamedTo, kicked };
}

export async function unhideTicketChannel({ web, entry, operatorIds = [] }) {
  const invited = [];
  for (const user of operatorIds) {
    try { await web.conversationsInvite({ channel: entry.channelId, users: user }); invited.push(user); }
    catch (e) { if (code(e) !== 'already_in_channel') throw e; }
  }
  const renamedTo = entry.name ?? null;
  if (renamedTo) await renameOrConfirm(web, entry.channelId, renamedTo);
  return { invited, renamedTo };
}
