// The title of a terminal the companion opens for a request. A runner record
// may name its tab ("mc: gemini <card-id>", card glmps-2-0-162); otherwise the
// title is the command's first word, as before.
export function terminalName(req: { name?: unknown; command?: unknown }): string {
  if (typeof req?.name === 'string') {
    const n = req.name.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 60);
    if (n) return n;
  }
  const cmd = typeof req?.command === 'string' ? req.command : '';
  return cmd ? `mc: ${cmd.split(' ')[0]}` : 'mc terminal';
}
