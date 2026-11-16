// server/lib/governance/shell-commands.js
//
// Shared by the role-permissions and push-lease cores: turn a Bash command line
// into the simple commands a shell would actually run, looking through quotes,
// separators and the usual wrappers. Pure; anything unparseable just yields
// fewer commands, never a throw.
// Quote-aware split at the separators a shell honours, plus parentheses and
// backticks so a subshell or substitution reads as its own command.
function segments(command) {
  const text = String(command ?? '');
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      cur += c;
      if (c === '\\' && q === '"' && i + 1 < text.length) { cur += text[i + 1]; i += 1; } else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ';' || c === '\n' || c === '\r' || c === '|' || c === '&' || c === '(' || c === ')' || c === '`') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// Quote-aware split so `git -C "D:/my repo" push` keeps the path whole.
function tokenize(seg) {
  const out = [];
  let cur = '';
  let has = false;
  let q = null;
  for (let i = 0; i < seg.length; i += 1) {
    const c = seg[i];
    if (q) {
      if (c === '\\' && q === '"' && (seg[i + 1] === '"' || seg[i + 1] === '\\')) { cur += seg[i + 1]; i += 1; } else if (c === q) q = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += c;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const PASS_THROUGH = new Set(['command', 'exec', 'nohup', 'time', 'builtin']);
const MAX_WRAP_DEPTH = 6;

function programName(t) {
  return String(t).split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

// Every simple command the shell would run, seen through wrappers
// (bash -c, cmd /c, powershell -Command, env, command, exec, VAR=x prefixes).
export function simpleCommands(command, depth = 0, out = []) {
  if (depth > MAX_WRAP_DEPTH) return out;
  for (const seg of segments(command)) {
    let t = tokenize(seg);
    for (;;) {
      while (t.length && ASSIGN.test(t[0])) t = t.slice(1);
      if (!t.length) break;
      const name = programName(t[0]);
      if (name === 'env') {
        t = t.slice(1);
        while (t.length && (t[0].startsWith('-') || ASSIGN.test(t[0]))) {
          t = t.slice(['-u', '-C', '-S'].includes(t[0]) ? 2 : 1);
        }
        continue;
      }
      if (PASS_THROUGH.has(name)) {
        t = t.slice(1);
        while (t.length && t[0].startsWith('-')) t = t.slice(1);
        continue;
      }
      let inner = null;
      if (SHELLS.has(name)) {
        const at = t.findIndex((x, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(x));
        if (at > 0 && t[at + 1] != null) inner = t[at + 1];
      } else if (name === 'cmd') {
        const at = t.findIndex((x, i) => i > 0 && /^\/[ck]$/i.test(x));
        if (at > 0) inner = t.slice(at + 1).join(' ');
      } else if (name === 'powershell' || name === 'pwsh') {
        const at = t.findIndex((x, i) => i > 0 && /^-c(o|om|omm|omma|omman|ommand)?$/i.test(x));
        if (at > 0) inner = t.slice(at + 1).join(' ');
      }
      if (inner != null) {
        simpleCommands(inner, depth + 1, out);
      } else {
        const tokens = [name, ...t.slice(1)];
        out.push({ tokens, seg: tokens.join(' ') });
      }
      break;
    }
  }
  return out;
}
