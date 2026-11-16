// server/lib/scut/ticket-migration.js
// One-time D27 migration: every ticket channel the store marks archived is
// unarchived and then hidden, so old tickets can come back by reply too.
// Idempotent: a rerun skips what is already hidden. Slack refuses unarchive
// for bot tokens (conversations.unarchive reference), so each refusal is
// listed with the manual step instead of being counted as done.
import { listTicketChannels, markHidden } from './ticket-channels.js';
import { hideTicketChannel } from './ticket-visibility.js';
import { postAs } from './provision.js';
import { resolveTheme } from './bobiverse.js';

const MIGRATION_SUMMARY = 'This ticket was closed before tickets were hidden instead of archived. The channel is now hidden but searchable; reply here, or rejoin it, to reopen the ticket.';
// Fix round 1, Minor (fold): only not_allowed_token_type is the KNOWN,
// permanent "bot tokens cannot unarchive" bug (conversations.unarchive
// reference) - that one gets the "do it by hand in Slack" instruction.
// no_permission and method_not_supported_for_channel_type are different
// failure classes (missing scope / wrong conversation type) that a manual
// unarchive will not fix, so they get their own named reason with the Slack
// code instead of the manual-step text.
const BOT_TOKEN_UNARCHIVE_REFUSAL = 'not_allowed_token_type';
const OTHER_UNARCHIVE_ERROR_CODES = new Set(['no_permission', 'method_not_supported_for_channel_type']);

export async function migrateArchivedChannels({ web, file, operatorIds = [], isClosed = () => true, dryRun = false, theme = resolveTheme(false) }) {
  const legacy = listTicketChannels({ file }).filter((e) => e.archivedTs && !e.hiddenTs);
  // `unarchived`, `hidden` and `failed` are INDEPENDENT tallies, not a
  // partition of `total`: a channel that unarchives successfully but then
  // fails the membership check or the hide step counts in BOTH `unarchived`
  // and `failed`. Never assume unarchived + hidden + failed === total.
  const report = { total: legacy.length, unarchived: 0, hidden: 0, failed: 0, failures: [] };
  if (dryRun) return report;
  const fail = (e, reason) => { report.failed++; report.failures.push({ channelId: e.channelId, name: e.name, ticketId: e.ticketId, reason }); };
  // Fix round 1, Minor (fold): post the closing summary through the same
  // riker persona the production close path uses (server.js's own
  // `postingWeb` wrapper around the hide action), not Slack's bare bot
  // identity.
  const postingWeb = { ...web, chatPostMessage: (m) => postAs(web, 'riker', m, theme) };
  for (const e of legacy) {
    try {
      let info = (await web.call('conversations.info', { channel: e.channelId }, { form: true }))?.channel ?? {};
      if (info.is_archived) {
        try { await web.call('conversations.unarchive', { channel: e.channelId }); }
        catch (err) {
          if (err?.code === BOT_TOKEN_UNARCHIVE_REFUSAL) { fail(e, `unarchive refused for bot tokens (${err.code}): unarchive it in Slack (open the channel, Unarchive), then rerun`); continue; }
          if (OTHER_UNARCHIVE_ERROR_CODES.has(err?.code)) { fail(e, `unarchive failed: ${err.code}`); continue; }
          throw err;
        }
        report.unarchived++;
        info = (await web.call('conversations.info', { channel: e.channelId }, { form: true }))?.channel ?? {};
      }
      if (!info.is_member) { fail(e, 'bot is not a member: invite Riker to the channel (/invite @Riker), then rerun'); continue; }
      if (!isClosed(e.ticketId)) { clearArchived(file, e.ticketId); continue; }
      // mark hidden as soon as the rename lands, not after
      // the whole hideTicketChannel sequence succeeds too (server.js:8508-8517
      // does the same for the live close path) - a kick failing afterward
      // must never leave the store claiming an archived channel that Slack
      // already shows renamed (and partially emptied) forever, which would
      // repost this same closing summary on every rerun. Unhide is
      // idempotent, so a later reopen still heals a partial hide.
      await hideTicketChannel({
        web: postingWeb, entry: e, operatorIds, summary: MIGRATION_SUMMARY,
        onRenamed: () => markHidden(e.ticketId, true, { file }),
      });
      report.hidden++;
    } catch (err) {
      fail(e, err?.code ?? err?.message ?? String(err));
    }
  }
  return report;
}

// An open card's channel is left visible; only the legacy flag is cleared so
// the rerun does not pick it up again. markHidden(true) with a null clock
// writes exactly { hiddenTs: null, archivedTs: null }; the third test pins it.
function clearArchived(file, ticketId) {
  markHidden(ticketId, true, { file, now: () => null });
}
