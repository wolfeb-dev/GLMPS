// Safe markdown -> HTML renderer for untrusted LLM output.
//
// XSS safety is the whole point: every character of user/model-derived text
// is escaped, and only the whitelisted constructs below are allowed to turn
// into real markup. Nothing from the input is ever emitted as a raw tag.

/** HTML-escape the five special characters. Coerces non-strings via String(). */
export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Model output can still slip an em-dash (U+2014) or horizontal bar (U+2015)
// despite the generation prompt's style guidance (wiki-llm.js PROMPT) -- this
// is the belt-and-suspenders backstop. Replace both with a spaced hyphen.
// Scoped to PROSE only: this runs inside inlineFormat, which is applied to
// headers/table-cells/list-items/paragraphs but NEVER to fenced code blocks
// (mermaid/vega-lite/js/...), so diagram and code source stay byte-exact.
// Built via fromCharCode/RegExp, not a literal character class, so this
// source file never contains a raw em-dash byte sequence itself.
const EM_DASH_RE = new RegExp('[' + String.fromCharCode(0x2014) + String.fromCharCode(0x2015) + ']', 'g');
function stripEmDash(s) {
  return s.replace(EM_DASH_RE, ' - ');
}

// Inline formatting is applied AFTER escaping, so the only special
// characters left to match on are the markdown markers themselves
// (` * [ ] ( )) -- none of which are HTML-significant.
function inlineFormat(s) {
  s = stripEmDash(s);
  // [[Wiki Title]] -> in-article link to another section. The parent frame
  // resolves data-wiki (a section title) to the right article on click.
  // [[Title|label]] shows the label and links the title.
  s = s.replace(/\[\[([^\][]+)\]\]/g, (_m, inner) => {
    const [title, label] = inner.split('|');
    const t = title.trim();
    return `<a class="wikilink" data-wiki="${t}" href="#">${(label ?? title).trim()}</a>`;
  });
  // `code`
  s = s.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  // **bold** (must run before single-* italic)
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, t) => `<strong>${t}</strong>`);
  // *italic*
  s = s.replace(/\*([^*]+)\*/g, (_m, t) => `<em>${t}</em>`);
  // [text](url) - only for whitelisted URL schemes; otherwise drop the link
  // and keep the (already-escaped) text. This is what blocks javascript: URLs.
  s = s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_m, text, url) => {
    return /^(https?:|\/|#|\.)/.test(url) ? `<a href="${url}">${text}</a>` : text;
  });
  return s;
}

const FENCE_RE = /^```\s*(\S*)\s*$/;
const FENCE_CLOSE_RE = /^```\s*$/;
const HEADER_RE = /^(#{1,3})(?!#)\s+(.*)$/;
const UL_RE = /^[-*]\s+(.*)$/;
const OL_RE = /^\d+\.\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;
// A quote that opens with a label is a callout (docs/wiki/style.md).
const CALLOUT_RE = /^(tip|warning):\s*/i;

/** Split a `a | b | c` row into trimmed cells, tolerating leading/trailing pipes. */
function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

function isSeparatorRow(line) {
  if (typeof line !== 'string' || !line.includes('-')) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function isTableStart(lines, i) {
  return (
    typeof lines[i] === 'string' &&
    lines[i].includes('|') &&
    i + 1 < lines.length &&
    isSeparatorRow(lines[i + 1])
  );
}

function isBlockStart(lines, i) {
  const line = lines[i];
  if (line.trim() === '') return true;
  if (FENCE_RE.test(line)) return true;
  if (HEADER_RE.test(line)) return true;
  if (UL_RE.test(line)) return true;
  if (OL_RE.test(line)) return true;
  if (QUOTE_RE.test(line)) return true;
  if (isTableStart(lines, i)) return true;
  return false;
}

/**
 * Render a markdown string to HTML, whitelisting only: h1-h3, paragraphs,
 * ul/ol lists, GFM pipe tables, fenced code blocks (with mermaid / vega-lite
 * special-cased), and inline code/bold/italic/links. Everything else is
 * plain escaped text.
 */
export function mdToHtml(md) {
  const text = typeof md === 'string' ? md : String(md ?? '');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }

    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      const lang = fenceMatch[1] || '';
      i++;
      const codeLines = [];
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume the closing ```
      const code = codeLines.join('\n');
      if (lang === 'mermaid') {
        out.push(`<pre class="mermaid">${esc(code)}</pre>`);
      } else if (lang === 'vega-lite') {
        out.push(`<div class="vega-lite" data-spec="${esc(code)}"></div>`);
      } else {
        out.push(`<pre><code>${esc(code)}</code></pre>`);
      }
      continue;
    }

    const headerMatch = line.match(HEADER_RE);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const content = inlineFormat(esc(headerMatch[2]));
      out.push(`<h${level}>${content}</h${level}>`);
      i++;
      continue;
    }

    if (isTableStart(lines, i)) {
      const headerCells = splitRow(lines[i]).map((c) => inlineFormat(esc(c)));
      i += 2; // skip header row + separator row
      const bodyRows = [];
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        bodyRows.push(splitRow(lines[i]).map((c) => inlineFormat(esc(c))));
        i++;
      }
      const theadRow = `<tr>${headerCells.map((c) => `<th>${c}</th>`).join('')}</tr>`;
      const bodyHtml = bodyRows
        .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<table><thead>${theadRow}</thead><tbody>${bodyHtml}</tbody></table>`);
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const quoted = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        quoted.push(lines[i].match(QUOTE_RE)[1]);
        i++;
      }
      const text = quoted.join(' ').trim();
      const label = text.match(CALLOUT_RE);
      if (label) {
        const kind = label[1].toLowerCase();
        const name = kind === 'tip' ? 'Tip' : 'Warning';
        out.push(`<aside class="wd-callout wd-callout-${kind}"><p class="wd-callout-label">${name}</p><p>${inlineFormat(esc(text.slice(label[0].length)))}</p></aside>`);
      } else {
        out.push(`<blockquote><p>${inlineFormat(esc(text))}</p></blockquote>`);
      }
      continue;
    }

    if (UL_RE.test(line)) {
      const items = [];
      while (i < lines.length && UL_RE.test(lines[i])) {
        items.push(lines[i].match(UL_RE)[1]);
        i++;
      }
      out.push(`<ul>${items.map((it) => `<li>${inlineFormat(esc(it))}</li>`).join('')}</ul>`);
      continue;
    }

    if (OL_RE.test(line)) {
      const items = [];
      while (i < lines.length && OL_RE.test(lines[i])) {
        items.push(lines[i].match(OL_RE)[1]);
        i++;
      }
      out.push(`<ol>${items.map((it) => `<li>${inlineFormat(esc(it))}</li>`).join('')}</ol>`);
      continue;
    }

    // Paragraph: consume consecutive lines until a blank line or another
    // block-starting construct.
    const paraLines = [];
    while (i < lines.length && !isBlockStart(lines, i)) {
      paraLines.push(lines[i]);
      i++;
    }
    out.push(`<p>${inlineFormat(esc(paraLines.join(' ')))}</p>`);
  }

  return out.join('');
}
