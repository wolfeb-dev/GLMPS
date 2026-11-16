// server/lib/scut/wake-delivery.js
// Pure decisions for how an operator's wake note reaches a parked session.
//
// Why: a wake reply arrives as a TOOL RESULT, which Claude Code's auto-mode
// classifier never reads as user intent, so the session's next edits are
// blocked as instruction poisoning. A note the server knows came from the
// operator can instead be delivered as a real user turn by resuming the session
// ("handoff"). Everything else keeps the tool-result wake.
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every Slack sender reaching a wake already passed the inbound allowlist
// guard, so the allowlist is the operator set. Fail closed on anything else.
export function noteProvenance({ user, allowedUsers = [] } = {}) {
  return user && allowedUsers.includes(user) ? 'operator' : 'external';
}

export function decideWakeDelivery({ provenance, handoffEnabled, sessionId } = {}) {
  if (provenance !== 'operator' || handoffEnabled !== true) return 'tool-result';
  return SESSION_UUID.test(String(sessionId ?? '')) ? 'handoff' : 'tool-result';
}
