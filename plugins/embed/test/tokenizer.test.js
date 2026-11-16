// Always-run unit test (no model, no network): the WordPiece tokenizer
// against a tiny inline vocab. Line index in the vocab text is the token id,
// mirroring how vocab.txt (one token per line) is laid out for real BERT/BGE
// vocabularies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadVocab, tokenize } from '../tokenizer.js';

const VOCAB_LINES = [
  '[PAD]', '[UNK]', '[CLS]', '[SEP]', '[MASK]',
  'hello', 'world', 'run', '##ning', 'ci', 'test', '.', ',', '!', '?',
  'cafe', 'naive', '\u4E2D', '\u6587', 'a', '##a',
];
const vocab = loadVocab(VOCAB_LINES.join('\n'));

test('loadVocab maps each line to its line index as the token id', () => {
  assert.equal(vocab.tokenToId.get('[PAD]'), 0);
  assert.equal(vocab.tokenToId.get('hello'), 5);
  assert.equal(vocab.tokenToId.get('##ning'), 8);
  assert.equal(vocab.unkId, 1);
  assert.equal(vocab.clsId, 2);
  assert.equal(vocab.sepId, 3);
});

test('lowercases input before matching the vocab', () => {
  const { inputIds } = tokenize('HELLO World', vocab);
  assert.deepEqual(inputIds, [2, 5, 6, 3]); // [CLS] hello world [SEP]
});

test('splits punctuation into its own tokens', () => {
  const { inputIds } = tokenize('hello, world!', vocab);
  assert.deepEqual(inputIds, [2, 5, 12, 6, 13, 3]); // [CLS] hello , world ! [SEP]
});

test('greedy longest-match WordPiece subwords with a ## continuation prefix', () => {
  const { inputIds } = tokenize('running', vocab);
  assert.deepEqual(inputIds, [2, 7, 8, 3]); // [CLS] run ##ning [SEP]
});

test('a word with no matching prefix in the vocab falls back to [UNK]', () => {
  const { inputIds } = tokenize('zzz', vocab);
  assert.deepEqual(inputIds, [2, 1, 3]); // [CLS] [UNK] [SEP]
});

test('wraps every sequence in [CLS] and [SEP] with matching attention mask and token type ids', () => {
  const { inputIds, attentionMask, tokenTypeIds } = tokenize('ci test', vocab);
  assert.equal(inputIds[0], vocab.clsId);
  assert.equal(inputIds[inputIds.length - 1], vocab.sepId);
  assert.deepEqual(attentionMask, new Array(inputIds.length).fill(1));
  assert.deepEqual(tokenTypeIds, new Array(inputIds.length).fill(0));
});

test('truncates to 512 tokens including [CLS] and [SEP]', () => {
  const longText = new Array(600).fill('hello').join(' ');
  const { inputIds } = tokenize(longText, vocab, { maxLen: 512 });
  assert.equal(inputIds.length, 512);
  assert.equal(inputIds[0], vocab.clsId);
  assert.equal(inputIds[511], vocab.sepId);
});

test('strips accents (NFD, drop Unicode Mn) before matching the vocab, matching BERT uncased order', () => {
  assert.deepEqual(tokenize('caf\u00E9', vocab).inputIds, [2, 15, 3]); // [CLS] cafe [SEP]
  assert.deepEqual(tokenize('na\u00EFve', vocab).inputIds, [2, 16, 3]); // [CLS] naive [SEP]
  assert.deepEqual(tokenize('CAF\u00C9', vocab).inputIds, [2, 15, 3]); // lowercase then strip accents
});

test('splits CJK characters one at a time, each its own token (BERT _tokenize_chinese_chars)', () => {
  const { inputIds, tokens } = tokenize('\u4E2D\u6587test', vocab);
  assert.deepEqual(tokens, ['[CLS]', '\u4E2D', '\u6587', 'test', '[SEP]']);
  assert.deepEqual(inputIds, [2, 17, 18, 10, 3]);
});

// The vocab includes 'a' and '##a' (not just special tokens and unrelated
// English words) specifically so these two tests are not vacuous: a word
// made entirely of 'a's *can* be tokenized piece by piece once it is short
// enough, so a 101-char run of 'a' becoming [UNK] actually exercises the
// MAX_INPUT_CHARS_PER_WORD guard rather than merely reflecting "this word
// isn't in the vocab" (which the previous version of this test, using a
// vocab with no 'a'/'##a' entry, could not tell apart from the guard firing
// -- deleting the guard entirely left it passing for the wrong reason).
test('a word of exactly 100 characters tokenizes normally, not forced to [UNK]', () => {
  const word100 = 'a'.repeat(100);
  const { tokens, inputIds } = tokenize(word100, vocab);
  assert.equal(tokens[0], '[CLS]');
  assert.equal(tokens[tokens.length - 1], '[SEP]');
  assert.ok(!tokens.includes('[UNK]'));
  // 'a' (1 char) + 99x '##a' (1 char each) = 100 pieces, plus [CLS]/[SEP].
  assert.equal(tokens.length, 102);
  assert.deepEqual(inputIds, [
    vocab.clsId,
    vocab.tokenToId.get('a'),
    ...new Array(99).fill(vocab.tokenToId.get('##a')),
    vocab.sepId,
  ]);
});

test('a word of 101 characters is forced to [UNK] by the length guard, even though the vocab can tokenize it piece by piece one character shorter', () => {
  const word101 = 'a'.repeat(101);
  const { tokens, inputIds } = tokenize(word101, vocab);
  assert.deepEqual(tokens, ['[CLS]', '[UNK]', '[SEP]']);
  assert.deepEqual(inputIds, [vocab.clsId, vocab.unkId, vocab.sepId]);
});
