# Third-party notices

## Orca (stablyai/orca)

The Cursor CLI, Grok, Pi and Factory Droid capture adapters re-implement the
session layouts and record parsing of Orca's AI Vault session scanner
(https://github.com/stablyai/orca, `src/main/ai-vault/`), ported from TypeScript
to this repo's zero-dependency JavaScript adapter shape. Orca is MIT licensed.

Files derived from Orca:

- `server/lib/adapters/cursor-cli.js`
- `server/lib/adapters/grok.js`
- `server/lib/adapters/pi.js`
- `server/lib/adapters/droid.js`
- the sanitized sample transcripts under `server/test/fixtures/cursor-cli/`,
  `grok/`, `pi/` and `droid/`, whose record shapes follow Orca's parser tests

The Cline, OpenCode and OpenClaw adapters are this project's own and are not
derived from Orca.

Orca license text, reproduced as required:

    MIT License
    
    Copyright (c) 2026 Lovecast Inc.
    
    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:
    
    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.
    
    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
