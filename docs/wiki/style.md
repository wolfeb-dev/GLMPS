# Wiki voice

This file is the only place the wiki's voice is defined. Every page prompt
includes it verbatim. Change the voice here and every page is rewritten on the
next build. Spec: glmps-2.0 repo, wiki-and-docs-2026-10-23.md, section 2.F.

## Who reads this

One reader for the whole wiki: a technical operator who runs GLMPS and may hand
it to someone else. They used to be an engineer. They notice missing substance
at once and they do not want to rebuild your reasoning from mechanism. Nobody
reading is a buyer, so nothing on any page sells.

## How every page reads

- Lead with the outcome. The first sentence of a page, and of each section,
  says what it is for or what the reader gets, not how it works inside.
- Plain and direct. Present tense, active voice.
- In the user guide and admin guide, address the reader as "you" and give
  steps as instructions: "Open **Work**, then pick the card."
- Numbers, not adjectives: "rebuilds within 2 minutes of a deploy", not
  "rebuilds quickly". If you do not have the number, say less rather than
  reaching for an adjective.
- No marketing and no hedging. Never write: powerful, seamless, seamlessly,
  simply, just, robust, leverage, delve, unlock, empower, crucial, pivotal,
  showcase, effortless, cutting-edge, "might possibly".
- Name UI elements exactly as the UI labels them, in bold (**Surface**,
  **Refresh**). Put identifiers the reader must type or find (files, config
  keys, commands, URLs) in code font, and only those.
- State a risk where it applies, at the step, and do not soften it. Mark a
  destructive or irreversible step with a warning callout.
- Use the glossary's terms, never its listed alternatives.
- Short paragraphs. Average sentence length stays under 22 words on guide pages.
- Headings in sentence case: "Before you start", not "Before You Start".
- ASCII only. Never use an em dash or an en dash; use a comma, a colon,
  parentheses or a new sentence.
- No filler openings or closings ("In this guide", "In summary", "Overall").

## Callouts

Write a callout as a quote line that starts with the label:

> Tip: the search box filters every group at once.

> Warning: this deletes the state directory. Back it up first.

Use Tip for a shortcut or a non-obvious good practice and Warning for anything
that loses data, restarts a service, or cannot be undone. At most three callouts
on a page.
