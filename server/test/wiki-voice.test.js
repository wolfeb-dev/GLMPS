// server/test/wiki-voice.test.js
// The voice files and the style lint the maker and the checker share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadVoice, lintRules, lintPage, partsFromMarkdown, partsFromHtml, BANNED_WORDS, VOICE_DIR,
} from '../lib/observability/wiki-voice.js';

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const FILES = ['style.md', 'templates.json', 'glossary.json'];

function voiceCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-voice-'));
  for (const f of FILES) fs.copyFileSync(path.join(VOICE_DIR, f), path.join(dir, f));
  return dir;
}

const RULES = {
  bannedWords: [...BANNED_WORDS], maxAvgSentenceWords: 22, properNouns: ['GLMPS', 'Surface', 'Claude Code'],
  terms: [{ term: 'card', avoid: ['ticket'], allow: ['wiki ticket'] }],
};
const lint = (md, opts = {}) => lintPage(partsFromMarkdown(md), { kind: 'guide', rules: RULES, ...opts });
const rulesOf = (v) => v.map(([r]) => r);

test('loadVoice reads the three voice files and hashes them', () => {
  const v = loadVoice();
  assert.ok(v.style.includes('# Wiki voice'));
  assert.ok(v.templates.guide.headings.length > 0);
  assert.ok(v.glossary.terms.length > 0);
  assert.match(v.hash, /^[0-9a-f]{40}$/);
  assert.equal(loadVoice().hash, v.hash, 'stable for unchanged files');
});

for (const f of FILES) {
  test(`loadVoice hash changes when ${f} changes`, () => {
    const dir = voiceCopy();
    const before = loadVoice(dir).hash;
    const file = path.join(dir, f);
    const text = fs.readFileSync(file, 'utf8');
    // a trailing space keeps both JSON files valid
    fs.writeFileSync(file, `${text.trimEnd()} \n`);
    assert.notEqual(loadVoice(dir).hash, before);
  });
}

test('lintRules carries banned words, the sentence cap, proper nouns and the glossary terms', () => {
  const v = loadVoice();
  const r = lintRules(v);
  assert.deepEqual(r.bannedWords, BANNED_WORDS);
  assert.equal(r.maxAvgSentenceWords, 22);
  assert.deepEqual(r.properNouns, v.glossary.properNouns);
  assert.equal(r.terms.length, v.glossary.terms.length);
  assert.deepEqual(r.terms[0], { term: 'card', avoid: ['ticket', 'backlog item', 'kanban item'], allow: ['wiki ticket', 'access ticket', 'ticket channel', 'ticket channels'] });
});

test('lintPage: a clean page has no violations', () => {
  assert.deepEqual(lint('## Purpose\n\nThe loop runs every six hours.', { required: ['Purpose'] }), []);
});

test('lintPage flags a missing required heading, case-insensitively', () => {
  assert.deepEqual(lint('## Something else\n\nText.', { required: ['Purpose'] }), [['headings', 'missing "## Purpose"']]);
  assert.deepEqual(lint('## purpose\n\nText.', { required: ['Purpose'] }), []);
  assert.deepEqual(lint('### Purpose\n\nText.', { required: ['Purpose'] }).length, 1, 'only level 2 counts');
});

test('lintPage flags a Title Case heading with two non-proper capitalised words', () => {
  assert.deepEqual(rulesOf(lint('## Before You Start\n\nText.')), ['heading-case']);
  assert.deepEqual(rulesOf(lint('### How It Works Today\n\nText.')), ['heading-case']);
});

test('lintPage lets a heading through with one proper noun, an acronym or sentence case', () => {
  assert.deepEqual(lint('## Use the Surface lens\n\nText.'), []);
  assert.deepEqual(lint('## Before you start\n\nText.'), []);
  assert.deepEqual(lint('## Open the Surface Claude Code view\n\nText.'), [], 'known multi-word proper nouns do not count');
  assert.deepEqual(lint('## Run the HTTP API\n\nText.'), []);
  assert.deepEqual(lint('## Install Windows\n\nText.'), [], 'the first word is never counted');
});

test('lintPage flags an em dash and an en dash in prose and in headings', () => {
  assert.deepEqual(rulesOf(lint(`Fast ${EM} and safe.`)), ['em-dash']);
  assert.deepEqual(rulesOf(lint(`Pages 3${EN}5.`)), ['em-dash']);
  assert.deepEqual(rulesOf(lint(`## Fast ${EM} safe\n\nText.`)), ['em-dash']);
});

for (const w of BANNED_WORDS) {
  test(`lintPage flags the banned word "${w}"`, () => {
    const v = lint(`This is ${w} text.`);
    assert.deepEqual(v, [['banned-word', `"${w}"`]]);
  });
}

test('lintPage matches banned words as whole words only', () => {
  assert.deepEqual(lint('You adjust the dial.'), [], 'adjust is not just');
  assert.deepEqual(lint('The justice board is unlocked by a key.'), [], 'justice and unlocked are not banned');
  assert.deepEqual(lint('A robustness check.'), []);
  assert.deepEqual(rulesOf(lint('Just do it.')), ['banned-word'], 'case-insensitive, at the start');
  assert.deepEqual(rulesOf(lint('Do it, just now.')), ['banned-word']);
});

test('lintPage flags a glossary avoid term, unless an allow phrase covers it', () => {
  assert.deepEqual(lint('Open the ticket now.'), [['glossary', '"ticket" where the glossary term is "card"']]);
  assert.deepEqual(lint('Post it in the wiki ticket channel.'), [], 'an allow phrase is scrubbed first');
  assert.equal(lint('A wiki ticket and a ticket.').length, 1, 'a bare use beside an allowed one still counts');
});

const longSentence = 'The kernel reads the configuration file from the state directory and then applies every key it finds to the running service before anything else happens at all today.';
const shortSentence = 'You open the page. You pick a card. You press the button. You read the result. You close the page.';

test('lintPage applies the sentence-length rule to guide and admin pages with 5 or more sentences', () => {
  const md = Array(5).fill(longSentence).join(' ');
  assert.deepEqual(rulesOf(lint(md, { kind: 'guide' })), ['sentence-length']);
  assert.deepEqual(rulesOf(lint(md, { kind: 'admin' })), ['sentence-length']);
  assert.deepEqual(lint(md, { kind: 'concept' }), [], 'concept pages are exempt');
  assert.deepEqual(lint(md, { kind: 'code' }), [], 'code pages are exempt');
  assert.deepEqual(lint(shortSentence), []);
});

test('lintPage skips the sentence-length rule below 5 sentences', () => {
  assert.deepEqual(lint(Array(4).fill(longSentence).join(' ')), []);
});

test('partsFromMarkdown reads headings and prose', () => {
  const p = partsFromMarkdown('# Title\n\n## Steps\n\nOpen **Work**.\n\n- Pick a card.\n- Press go.\n\n> Tip: be quick.\n');
  assert.deepEqual(p.headings, [{ level: 1, text: 'Title' }, { level: 2, text: 'Steps' }]);
  assert.deepEqual(p.paragraphs, ['Open **Work**.']);
  assert.match(p.prose, /Pick a card\./);
  assert.match(p.prose, /Tip: be quick\./);
});

test('partsFromMarkdown ignores fenced code, inline code and table rows', () => {
  const md = [
    '## Steps', '',
    'Run `just robust` now.', '',
    '```sh', 'just --robust # leverage', '```', '',
    '| Key | Meaning |', '| --- | --- |', '| robust | seamless |', '',
    'Done.',
  ].join('\n');
  const p = partsFromMarkdown(md);
  assert.doesNotMatch(p.prose, /robust|seamless|leverage|just/);
  assert.deepEqual(lint(md), []);
});

const wrap = (inner) => `<article><div class="wd-body">${inner}</div><!-- /wd-body --><nav class="wiki-related"><h2>Related</h2><p>just robust</p></nav></article>`;

test('partsFromHtml reads headings, paragraphs and list items inside wd-body only', () => {
  const p = partsFromHtml(wrap('<h2>Purpose</h2><p>It runs &amp; stops.</p><ul><li>One thing</li></ul><aside class="wd-callout"><p>Tip body</p></aside>'));
  assert.deepEqual(p.headings, [{ level: 2, text: 'Purpose' }]);
  assert.deepEqual(p.paragraphs, ['It runs & stops.']);
  assert.match(p.prose, /One thing/);
  assert.doesNotMatch(p.prose, /robust/, 'the related nav is outside wd-body');
});

test('partsFromHtml gives nothing for a page without a wd-body', () => {
  assert.deepEqual(partsFromHtml('<article><p>just robust</p></article>'), { headings: [], paragraphs: [], prose: '', all: '' });
});

test('partsFromHtml ignores wd-reference, details, pre, code and tables', () => {
  const html = wrap([
    '<h2>Purpose</h2><p>Clean prose with <code>just</code> inline.</p>',
    '<pre>just robust</pre>',
    '<table><tr><td>seamless</td></tr></table>',
    '<details class="wd-files"><summary>Files</summary><p>leverage</p></details>',
    '<section class="wd-reference"><h2>Routes</h2><p>powerful</p><table><tr><td>delve</td></tr></table></section>',
    '<figure><pre class="mermaid">crucial</pre></figure>',
  ].join(''));
  const p = partsFromHtml(html);
  assert.deepEqual(p.headings, [{ level: 2, text: 'Purpose' }], 'the reference heading is not a body heading');
  assert.doesNotMatch(p.prose, /just|robust|seamless|leverage|powerful|delve|crucial/);
  assert.deepEqual(lintPage(p, { kind: 'admin', required: ['Purpose'], rules: RULES }), []);
});

test('partsFromHtml and partsFromMarkdown lint the same page the same way', () => {
  const md = '## Purpose\n\nIt is robust.';
  const html = wrap('<h2>Purpose</h2><p>It is robust.</p>');
  const o = { kind: 'guide', required: ['Purpose'], rules: RULES };
  assert.deepEqual(lintPage(partsFromHtml(html), o), lintPage(partsFromMarkdown(md), o));
});

test('lintPage flags private text anywhere in the page, code and tables included', () => {
  const rules = { ...RULES, privateNames: ['zed'] };
  const cases = [
    'See C:\\Users\\zed\\x for it.',
    'Run `node /home/zed/app.js` first.',
    'Brain in .gemini/antigravity here.',
    'Written by zed.',
    'Fixed in glmps-2-0-193.',
    '```\nD:/work/file\n```',
    '| path |\n| --- |\n| E:\\data |',
  ];
  for (const md of cases) {
    assert.ok(rulesOf(lint(`## Purpose\n\n${md}`, { rules })).includes('private-text'), md);
  }
});

test('lintPage private-text names the pattern and passes clean text', () => {
  const v = lint('## Purpose\n\nOpen C:\\Users\\zed\\x.', { rules: { ...RULES, privateNames: [] } });
  assert.deepEqual(v.filter(([r]) => r === 'private-text').map(([, d]) => d.includes('drive path')), [true]);
  assert.deepEqual(lint('## Purpose\n\nThe loop runs at config.json.', { rules: { ...RULES, privateNames: ['zed'] } }), []);
});

test('lintPage private-text skips a name under 3 characters', () => {
  assert.deepEqual(lint('## Purpose\n\nal wrote this.', { rules: { ...RULES, privateNames: ['al'] } }), []);
});

test('the html path sees private text in code blocks too', () => {
  const html = wrap('<h2>Purpose</h2><p>ok</p><pre>C:\\Users\\zed\\x</pre>');
  const v = lintPage(partsFromHtml(html), { kind: 'guide', rules: { ...RULES, privateNames: [] } });
  assert.ok(rulesOf(v).includes('private-text'));
});

test('lintRules carries the private names the caller passes', () => {
  assert.deepEqual(lintRules(loadVoice(), { privateNames: ['zed'] }).privateNames, ['zed']);
  assert.deepEqual(lintRules(loadVoice()).privateNames, []);
});

test('the voice hash covers the lint rules, not only the three voice files', async () => {
  const crypto = await import('node:crypto');
  const h = crypto.createHash('sha1');
  for (const f of FILES) h.update(fs.readFileSync(path.join(VOICE_DIR, f), 'utf8'));
  assert.notEqual(loadVoice().hash, h.digest('hex'));
});
