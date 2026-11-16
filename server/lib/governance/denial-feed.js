// Pure core of hooks/denial-feed.js: the devlog line for an auto-mode denial.
export const EXCERPT_CHARS = 200;

export function inputExcerpt(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const direct = typeof toolInput.command === 'string' ? toolInput.command
    : typeof toolInput.file_path === 'string' ? toolInput.file_path
      : null;
  let text = direct;
  if (text === null) {
    try { text = JSON.stringify(toolInput); } catch { text = ''; }
  }
  return String(text ?? '').slice(0, EXCERPT_CHARS);
}

export function denialLine({ tool_name, tool_input, reason } = {}) {
  return `Blocked by auto mode: ${reason || 'no reason given'} on ${tool_name || 'unknown tool'}: ${inputExcerpt(tool_input)}`;
}
