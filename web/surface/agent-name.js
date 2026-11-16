// web/surface/agent-name.js
// How Surface names an agent: by the card it works on, else by its tool and a
// short session id. The auto-written session title is a summary, and Surface
// does not show those (it can still search them; see search.js).
export function agentName(state, id) {
  const sid = String(id);
  const s = (state?.sessions ?? []).find((x) => x.id === sid);
  if (s?.card?.id) return s.card.id;
  const tool = s?.tool ?? state?.board?.rows?.find((r) => r.id === sid)?.tool;
  return `${tool ?? 'agent'} ${sid.slice(0, 8)}`;
}
