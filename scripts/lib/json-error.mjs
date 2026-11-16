// JSON.parse messages can quote the source around the error, and config files
// hold credentials, so only the position (or the kind of error) is reported.
// Lives here, not in shadow-instance.mjs, so the shipped installer does not
// import an operator-only tool.
export function jsonErrorWhere(e) {
  const msg = String(e?.message || '');
  const m = msg.match(/at position (\d+)(?: \(line (\d+) column (\d+)\))?/);
  if (m) return m[2] ? `at position ${m[1]} (line ${m[2]} column ${m[3]})` : `at position ${m[1]}`;
  if (/unexpected end of JSON input/i.test(msg)) return 'unexpected end of input';
  return 'unexpected token; position not reported';
}
