#!/usr/bin/env node
// scripts/setup/slack-creds.mjs - the setup wizard's door to SCUT's existing
// credential store (server/lib/scut/config.js). No second secrets file.
//   --check   exit 0 when valid tokens are already saved or in the env, else 1
//   --save    save SETUP_BOT_TOKEN / SETUP_APP_TOKEN / SETUP_SIGNING_SECRET (optional)
// Tokens arrive through the environment, never argv, and are never printed.
import { loadCreds, saveCreds, validateCreds } from '../../server/lib/scut/config.js';

const mode = process.argv[2];
if (mode === '--check') {
  process.exit(validateCreds(loadCreds()).ok ? 0 : 1);
} else if (mode === '--save') {
  const creds = {
    botToken: process.env.SETUP_BOT_TOKEN,
    appToken: process.env.SETUP_APP_TOKEN,
    ...(process.env.SETUP_SIGNING_SECRET ? { signingSecret: process.env.SETUP_SIGNING_SECRET } : {}),
  };
  const v = validateCreds(creds);
  if (!v.ok) { console.error(`not saved: ${v.errors.join('; ')}`); process.exit(1); }
  saveCreds(creds);
  console.log('Slack tokens saved to the SCUT credential store.');
} else {
  console.error('usage: slack-creds.mjs --check | --save');
  process.exit(2);
}
