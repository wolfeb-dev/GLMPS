// apps/shell/src/lib/user-agent.js
// Slack may refuse huddles to a browser it does not recognise as Chrome; the
// default Electron user agent carries an `Electron/<v>` token and the app
// name (electron-44.4.5 does not vendor a literal sample string, but every
// Electron app observed in the wild - Slack's own desktop build included -
// splices "<productName>/<version> Chrome/<ver> Electron/<ver>" into the
// otherwise-ordinary Chromium user agent, ahead of the trailing Safari
// token). Rather than assume that exact token order or position, this keeps
// only the fixed Chromium anchors (Mozilla, the platform parens, AppleWebKit,
// the "(KHTML, like Gecko)" marker, Chrome and the trailing Safari token) and
// drops every other `<name>/<version>` word, wherever Electron puts it and
// however many words the app name itself contains (this shell's own
// productName, "GLMPS 2.0", has a space in it).
const CHROME_UA = /^(Mozilla\/5\.0 \([^)]*\) AppleWebKit\/[\d.]+ \(KHTML, like Gecko\)).*?(Chrome\/[\d.]+).*?(Safari\/[\d.]+)$/;

export function chromeUserAgent(electronUa) {
  const ua = String(electronUa ?? '');
  const m = CHROME_UA.exec(ua);
  // Fails open to the original string, unmodified, rather than guessing at a
  // shape it does not recognise: Slack seeing the Electron-branded UA is a
  // functionality regression, not a security one.
  if (!m) return ua;
  return `${m[1]} ${m[2]} ${m[3]}`;
}
