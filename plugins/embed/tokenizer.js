// A plain-JS BERT WordPiece tokenizer, matching the reference implementation
// (HuggingFace transformers' BasicTokenizer + WordpieceTokenizer, do_lower_case
// = true) closely enough to reproduce its token ids for an uncased vocab such
// as bge-small-en-v1.5's (which reuses bert-base-uncased's vocab.txt). No
// vendored dependency: this is our own code, not upstream, so it lives outside
// vendor/ and is free to import (and be imported) normally.

const MAX_INPUT_CHARS_PER_WORD = 100;

// vocab.txt is one token per line; the line index is the token id.
export function loadVocab(text) {
  const tokenToId = new Map();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '' && i === lines.length - 1) continue; // trailing newline
    tokenToId.set(lines[i], i);
  }
  const need = (t) => {
    const id = tokenToId.get(t);
    if (id === undefined) throw new Error(`vocab is missing required special token ${t}`);
    return id;
  };
  return {
    tokenToId,
    unkId: need('[UNK]'),
    clsId: need('[CLS]'),
    sepId: need('[SEP]'),
    padId: need('[PAD]'),
  };
}

// ASCII ranges match CPython's/BERT's own _is_punctuation: characters that are
// not alnum but sit in these ranges (covers !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~)
// count as punctuation even though some (e.g. '$', '^') are Unicode category
// "Symbol" rather than "Punctuation". \p{P} covers the rest (non-ASCII
// punctuation).
function isPunctuation(ch) {
  const cp = ch.codePointAt(0);
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
  return /\p{P}/u.test(ch);
}

function isWhitespace(ch) {
  return /\s/.test(ch);
}

// BERT's BasicTokenizer (do_lower_case=true) order is: lowercase, then strip
// accents, via unicodedata.normalize("NFD", text) followed by dropping every
// character whose Unicode category is Mn (a combining mark). NFD splits a
// precomposed accented character (e.g. U+00E9 "e" with acute) into its base
// letter plus a separate combining-mark codepoint, so dropping \p{Mn} after
// NFD leaves the bare base letters: "cafe" (matching vocab.txt, which -- like
// bert-base-uncased's -- has no accented entries).
function stripAccents(text) {
  return text.normalize('NFD').replace(/\p{Mn}/gu, '');
}

// BERT's _is_chinese_char: these ranges cover the CJK Unified Ideographs
// blocks (and their extensions/compatibility blocks), not Hiragana/Katakana/
// Hangul. Matches the reference implementation's ranges exactly.
function isChineseChar(cp) {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

// BERT's _tokenize_chinese_chars: pads every CJK character with spaces so the
// whitespace split below always isolates it as its own token, since CJK text
// is not normally whitespace-segmented into "words" the way English is.
// Iterating with for...of yields whole code points, so a character outside
// the BMP (e.g. in the 0x20000-0x2A6DF supplementary range) is handled as one
// unit rather than being split into its two UTF-16 surrogate halves.
function tokenizeChineseChars(text) {
  let out = '';
  for (const ch of text) {
    out += isChineseChar(ch.codePointAt(0)) ? ` ${ch} ` : ch;
  }
  return out;
}

// Splits on whitespace and around punctuation, keeping punctuation characters
// as their own tokens (e.g. "hello, world!" -> ["hello", ",", "world", "!"]).
function basicTokenize(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (const word of words) {
    let current = '';
    for (const ch of word) {
      if (isWhitespace(ch)) continue; // defensive; words are already whitespace-free
      if (isPunctuation(ch)) {
        if (current) { out.push(current); current = ''; }
        out.push(ch);
      } else {
        current += ch;
      }
    }
    if (current) out.push(current);
  }
  return out;
}

// Greedy longest-match-first subword split of a single whitespace/punctuation
// token, with a "##" prefix on every continuation piece. Falls back to
// [UNK] for the whole token if no split covers it (or it is implausibly long).
function wordpiece(token, vocab) {
  const chars = Array.from(token);
  if (chars.length > MAX_INPUT_CHARS_PER_WORD) return ['[UNK]'];
  const subTokens = [];
  let start = 0;
  while (start < chars.length) {
    let end = chars.length;
    let matched = null;
    while (start < end) {
      let substr = chars.slice(start, end).join('');
      if (start > 0) substr = '##' + substr;
      if (vocab.tokenToId.has(substr)) { matched = substr; break; }
      end -= 1;
    }
    if (matched === null) return ['[UNK]'];
    subTokens.push(matched);
    start = end;
  }
  return subTokens;
}

// tokenize(text, vocab, { maxLen }) -> { inputIds, attentionMask, tokenTypeIds, tokens }
// maxLen counts [CLS] and [SEP] (default 512, BERT/BGE's own limit).
export function tokenize(text, vocab, { maxLen = 512 } = {}) {
  const preprocessed = tokenizeChineseChars(stripAccents(String(text).toLowerCase()));
  const basic = basicTokenize(preprocessed);
  let pieces = basic.flatMap((t) => wordpiece(t, vocab));
  if (pieces.length > maxLen - 2) pieces = pieces.slice(0, maxLen - 2);
  const tokens = ['[CLS]', ...pieces, '[SEP]'];
  const inputIds = tokens.map((t) => vocab.tokenToId.get(t) ?? vocab.unkId);
  const attentionMask = new Array(inputIds.length).fill(1);
  const tokenTypeIds = new Array(inputIds.length).fill(0);
  return { inputIds, attentionMask, tokenTypeIds, tokens };
}
