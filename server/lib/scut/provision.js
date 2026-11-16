// server/lib/scut/provision.js
// SCUT provisioning helpers built on the injected slack-web client + the ACTIVE
// theme (resolveTheme(bobMode)). The theme is passed in so persona names/icons
// follow the current Bob-mode setting. Pure orchestration -> unit-testable.

const FALLBACK_ICON = ':robot_face:';

/**
 * Post a message AS an agent: stamps the persona from the ACTIVE theme.
 *
 * The picture is a profile picture (icon_url) when the operator has published
 * an avatar set, and the persona emoji otherwise. Exactly ONE of the two fields
 * is ever sent: Slack's precedence when both are present is not contractual, so
 * an unambiguous wire message is worth more than a belt-and-braces fallback.
 * Both forms need the same chat:write.customize scope, so there is nothing extra
 * to install to turn pictures on.
 */
export function postAs(web, agentId, { channel, text, thread_ts, blocks, reply_broadcast } = {}, theme) {
  const a = theme?.agentById?.(agentId);
  const username = a ? a.display : String(agentId);
  const avatar = theme?.avatarFor?.(agentId) ?? null;
  const picture = avatar ? { icon_url: avatar } : { icon_emoji: a ? a.icon : FALLBACK_ICON };
  // A ticket channel's room has no thread (glmps-92), and the key
  // must then be ABSENT rather than null: JSON.stringify keeps a null, so
  // sending it would put `"thread_ts": null` on the wire for every
  // channel-level post. Omit it, and the message lands in the channel.
  return web.chatPostMessage({
    channel, text, username, ...picture,
    ...(thread_ts ? { thread_ts } : {}),
    ...(thread_ts && reply_broadcast ? { reply_broadcast: true } : {}),
    ...(blocks ? { blocks } : {}),
  });
}

/**
 * Ensure each channel name exists, creating the missing ones. Idempotent.
 * Returns { created:[names], existing:[names], byName:{name->channelObj} }.
 * NOTE: conversationsList is not paginated yet (fine for a fresh/small workspace;
 * hardening tracked in the spec).
 */
export async function ensureChannels(web, names) {
  const list = await web.conversationsList();
  const existingByName = new Map((list.channels || []).map((c) => [c.name, c]));
  const created = [];
  const existing = [];
  const byName = {};
  for (const name of names) {
    if (existingByName.has(name)) {
      existing.push(name);
      byName[name] = existingByName.get(name);
    } else {
      const r = await web.conversationsCreate(name);
      created.push(name);
      byName[name] = r.channel;
    }
  }
  return { created, existing, byName };
}

/** Post the "SCUT online" hello to the hub as two agents, proving persona identity. */
export async function postHello(web, { channelId }, theme) {
  await postAs(web, 'riker', { channel: channelId, text: 'SCUT online. All stations, report in. :satellite:' }, theme);
  await postAs(web, 'bill', { channel: channelId, text: 'Transceiver green - the Skunk Works is nominal. :hammer_and_wrench:' }, theme);
}
