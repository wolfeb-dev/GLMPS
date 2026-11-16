// server/lib/scut/connect.js
// The setup wizard's non-interactive Slack connect. The same steps runWizard
// (wizard.js) walks a console through, but the tokens and the operator's
// identity arrive as inputs and the outcome is one structured result, so the
// desktop wizard can render it. Every effect is injected; scripts/setup/
// slack-connect.mjs wires the real modules.
//
// Never throws for a per-channel or per-user failure: those become warnings,
// because a half-provisioned workspace is recoverable and a wizard that dies
// partway is not. A token Slack rejects returns { ok: false, error: <code> }.
// No token is ever placed in the result.
import { validateCreds } from './config.js';

const codeOf = (e) => e?.code ?? e?.message ?? String(e);

/**
 * checkSlackTokens({ botToken, appToken, makeWeb }) ->
 *   { ok: true, team, botUser } | { ok: false, error }
 *
 * Both tokens, live. The app token is checked with apps.connections.open, the
 * call Socket Mode makes at boot, so a wrong, revoked or connections:write-less
 * xapp token fails here instead of after the restart. Its codes carry an
 * 'app_token:' prefix because invalid_auth from either token reads the same.
 * The socket URL it returns is never opened and expires on its own.
 */
// A failure that is not Slack's answer (offline, DNS, timeout) says nothing
// about the tokens, so it is marked unreachable rather than read as rejected.
const failed = (e, prefix = '') => (e?.name === 'SlackError'
  ? { ok: false, error: `${prefix}${codeOf(e)}` }
  : { ok: false, error: 'unreachable', unreachable: true });

export async function checkSlackTokens({ botToken, appToken, makeWeb }) {
  let auth;
  try { auth = await makeWeb(botToken).authTest(); } catch (e) { return failed(e); }
  try { await makeWeb(appToken).call('apps.connections.open'); } catch (e) { return failed(e, 'app_token:'); }
  return { ok: true, team: auth.team ?? null, botUser: auth.user ?? null };
}

/**
 * Inputs: botToken, appToken, signingSecret?, email?, memberId?
 * Injected: saveCreds, makeWeb, ensureChannels, postHello, theme, addAllowedUser,
 *           projects, bindProjectChannels
 */
export async function connectSlack(deps) {
  const {
    botToken, appToken, signingSecret, email, memberId,
    saveCreds, makeWeb, ensureChannels, postHello, theme, addAllowedUser,
    projects, bindProjectChannels,
  } = deps;

  const creds = { botToken, appToken, ...(signingSecret ? { signingSecret } : {}) };
  const valid = validateCreds(creds);
  if (!valid.ok) return { ok: false, error: 'invalid_tokens', detail: valid.errors };

  const checked = await checkSlackTokens({ botToken, appToken, makeWeb });
  if (!checked.ok) return { ok: false, error: checked.error };
  const web = makeWeb(botToken);

  try { saveCreds(creds); } catch (e) { return { ok: false, error: 'save_failed', detail: [e?.message ?? String(e)] }; }

  const warnings = [];
  const result = { ok: true, team: checked.team, botUser: checked.botUser, channels: { created: [], existing: [] }, userId: null, joined: [], warnings };

  const channelNames = theme.channelNames();
  let prov;
  try { prov = await ensureChannels(web, channelNames); } catch (e) {
    return { ...result, ok: false, error: codeOf(e), credsSaved: true };
  }
  result.channels.created.push(...prov.created);
  result.channels.existing.push(...prov.existing);
  const provisioned = channelNames
    .map((name) => ({ name, id: prov.byName?.[name]?.id }))
    .filter((c) => c.id);

  for (const project of projects ?? []) {
    try {
      const name = theme.channelForProject(project);
      const r = await ensureChannels(web, [name]);
      (r.created.includes(name) ? result.channels.created : result.channels.existing).push(name);
      if (r.byName?.[name]?.id) provisioned.push({ name, id: r.byName[name].id });
      bindProjectChannels?.(project);
    } catch (e) {
      warnings.push(`project ${project} could not be provisioned (${codeOf(e)})`);
    }
  }

  const hubName = theme.channels.hub.name;
  const hub = prov.byName?.[hubName];
  if (hub?.id) {
    try { await postHello(web, { channelId: hub.id }, theme); } catch (e) { warnings.push(`the hello to #${hubName} was not posted (${codeOf(e)})`); }
  } else {
    warnings.push(`#${hubName} was not found, so no hello was posted`);
  }

  let userId = typeof memberId === 'string' && memberId.trim() ? memberId.trim() : null;
  if (!userId && email) {
    try { userId = (await web.usersLookupByEmail({ email })).user?.id ?? null; } catch (e) {
      warnings.push(`could not find ${email} in the workspace (${codeOf(e)}); paste a member ID instead`);
    }
  }
  if (!userId) {
    if (!email) warnings.push('no Slack member was given, so nobody is authorized to command agents yet');
    return result;
  }
  result.userId = userId;
  if (addAllowedUser) {
    try { addAllowedUser(userId); } catch (e) { warnings.push(`could not authorize ${userId} (${codeOf(e)})`); }
  }

  for (const ch of provisioned) {
    try {
      await web.conversationsInvite({ channel: ch.id, users: userId });
      result.joined.push(ch.name);
    } catch (e) {
      // already_in_channel is the normal outcome of a re-run: the goal is met.
      if (e?.code === 'already_in_channel') { result.joined.push(ch.name); continue; }
      warnings.push(`could not add you to #${ch.name} (${codeOf(e)})`);
    }
  }
  return result;
}
