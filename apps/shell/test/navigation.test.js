// apps/shell/test/navigation.test.js
// GLMPS 2.0 identity: the kernel origin used by these tests is the
// separated-build default port 8124 (apps/shell/src/lib/endpoints.js
// DEFAULT_KERNEL_URL), not the production 8123.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl, externalUrl, isSlackHost, isSlackOrigin, SLACK_HOME } from '../src/lib/navigation.js';

const K = 'http://127.0.0.1:8124';
const dash = (url) => classifyUrl({ role: 'dashboard', url, kernelOrigin: K });
const slack = (url) => classifyUrl({ role: 'slack', url, kernelOrigin: K });

test('each view stays inside its own origin', () => {
  assert.equal(dash('http://127.0.0.1:8124/#/surface?layer=residency'), 'internal');
  assert.equal(slack(SLACK_HOME), 'internal');
  assert.equal(slack('https://slack.com/signin'), 'internal');
  assert.equal(slack('https://myteam.slack.com/ssb/redirect'), 'internal');
});

test('a Slack link to the kernel opens in the dashboard pane, and back', () => {
  assert.equal(slack('http://127.0.0.1:8124/#/work?card=glmps-100'), 'to-dashboard');
  assert.equal(dash('https://app.slack.com/client/T1/C2'), 'to-slack');
});

test('lookalikes and credential tricks are external, never internal', () => {
  assert.equal(slack('https://app.slack.com.evil.test/client'), 'external');
  assert.equal(slack('https://evilslack.com/'), 'external');
  assert.equal(slack('http://app.slack.com/client'), 'external');          // http, not https
  assert.equal(slack('http://127.0.0.1:8124@evil.test/'), 'external');     // userinfo trick
  assert.equal(dash('http://127.0.0.1:8123/'), 'external');                // another port is another origin
  assert.equal(dash('https://github.com/wolfeb-dev/glmps'), 'external');
  assert.equal(slack('mailto:ops@example.com'), 'external');
});

test('non-web schemes and garbage are blocked', () => {
  for (const u of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'slack://open', 'data:text/html,hi', 'not a url', 'ms-settings:']) {
    assert.equal(slack(u), 'block', u);
    assert.equal(dash(u), 'block', u);
  }
  assert.equal(classifyUrl({ role: 'local', url: SLACK_HOME, kernelOrigin: K }), 'block');
});

test('externalUrl only passes http, https and mailto without userinfo, up to 2081 chars', () => {
  assert.equal(externalUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(externalUrl('mailto:ops@example.com'), 'mailto:ops@example.com');
  assert.equal(externalUrl('javascript:alert(1)'), null);
  assert.equal(externalUrl('file:///C:/x'), null);
  assert.equal(externalUrl('https://user:pw@example.com/'), null);
  assert.equal(externalUrl('https://example.com/' + 'a'.repeat(2100)), null);
});

test('isSlackHost', () => {
  assert.equal(isSlackHost('slack.com'), true);
  assert.equal(isSlackHost('app.slack.com'), true);
  assert.equal(isSlackHost('slack.com.evil.test'), false);
  assert.equal(isSlackHost('notslack.com'), false);
});

test('isSlackHost is case-insensitive and tolerates one trailing dot', () => {
  assert.equal(isSlackHost('APP.SLACK.COM'), true);
  assert.equal(isSlackHost('slack.com.'), true);
});

// 2026-10-02 (PR #29 review): a slack-role session can still host a
// cross-origin frame (an embedded third-party widget, an ad); a grant must be
// scoped to the actual requesting origin, not just the partition it lives in.
test('isSlackOrigin requires https and a slack.com host', () => {
  assert.equal(isSlackOrigin('https://app.slack.com'), true);
  assert.equal(isSlackOrigin('https://my-team.slack.com'), true);
  assert.equal(isSlackOrigin('http://app.slack.com'), false); // http, not https
  assert.equal(isSlackOrigin('https://app.slack.com.evil.test'), false);
  assert.equal(isSlackOrigin('https://example.com'), false);
});

test('isSlackOrigin fails closed on an absent or unparseable origin', () => {
  for (const origin of ['', null, undefined, 'not a url']) {
    assert.equal(isSlackOrigin(origin), false, String(origin));
  }
});

// Task 15, L1 (security review): the URL parser leaves a mailto path's `"`,
// spaces, `<`, `>` and backtick raw, and shell.openExternal hands the href to
// the Windows mail handler on a command line (the argument-splitting class).
// A mailto carrying any of them is refused; an ordinary address, and a query
// the parser itself percent-encodes, still pass.
test('L1: a mailto with a quote, whitespace, angle bracket or backtick is refused', () => {
  for (const bad of ['mailto:a"b@x.com', 'mailto:a b@x.com', 'mailto:<a@x.com>', 'mailto:a>b@x.com', 'mailto:a`b@x.com', 'mailto:a@x.com" --flag']) {
    assert.equal(externalUrl(bad), null, bad);
  }
  assert.equal(externalUrl('mailto:ops@example.com?subject=hi there'), 'mailto:ops@example.com?subject=hi%20there');
  assert.equal(externalUrl('mailto:a%22b@x.com'), 'mailto:a%22b@x.com');
});
