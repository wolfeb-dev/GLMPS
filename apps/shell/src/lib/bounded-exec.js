// apps/shell/src/lib/bounded-exec.js
// The smoke probe's bounded executeJavaScript. executeJavaScript against a
// webContents whose renderer just crashed can sit pending indefinitely
// (Electron 44.4.5) rather than reject, which would defeat a polling loop's
// own timeout, so each attempt is raced against its own timer.
// failures used to vanish into a bare catch; the last one is now
// kept (cleared by a success) so a failing check can name it in its detail.
export function createBoundedExec() {
  let last = null;
  async function tryExec(wc, code, attemptMs = 1500) {
    let timer = null;
    try {
      const value = await Promise.race([
        wc.executeJavaScript(code),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`executeJavaScript timed out after ${attemptMs} ms`)), attemptMs); }),
      ]);
      last = null;
      return value;
    } catch (e) {
      last = e?.message || String(e);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
  return { tryExec, lastError: () => last };
}
