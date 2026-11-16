// One path-identity rule for the orchestration layer: separators folded to
// '/', trailing slashes dropped, case folded (Windows paths are
// case-insensitive). `collapse` also merges runs of '/', which a caller that
// compares working directories wants and a caller that may see a UNC prefix
// does not.
export function normPath(p, { lower = true, collapse = false } = {}) {
  let s = String(p ?? '').replace(/\\/g, '/');
  if (collapse) s = s.replace(/\/+/g, '/');
  s = s.replace(/\/+$/, '');
  return lower ? s.toLowerCase() : s;
}
