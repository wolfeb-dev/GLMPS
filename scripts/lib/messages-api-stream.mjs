// scripts/lib/messages-api-stream.mjs
// BENCH ONLY (D28). One streaming call to the Anthropic Messages API over
// node:https, used by scripts/huddle-bench.mjs as the paid-API measurement
// arm, and only when ANTHROPIC_API_KEY is set. The product path is
// server/lib/plugins/claude-stream.js (claude -p on the operator's plan);
// nothing under server/ imports this file.
import https from 'node:https';

const API_HOST = 'api.anthropic.com';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// Feed raw text chunks; calls onEvent(eventName, parsedJson) once per complete
// SSE event. Tolerates events split across chunks and skips unparsable data.
export function createSseParser(onEvent) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = null;
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (!data.length) continue;
      let json;
      try { json = JSON.parse(data.join('\n')); } catch { continue; }
      onEvent(event ?? json.type ?? null, json);
    }
  };
}

export function streamMessage({ apiKey, body, onText, signal, fallbacks = false, request = https.request, now = Date.now }) {
  return new Promise((resolve, reject) => {
    if (!apiKey) { reject(new Error('no api key')); return; }
    const { transcript, speakerId, instruction, ...apiBody } = body ?? {};
    const payload = JSON.stringify(fallbacks ? { ...apiBody, stream: true, fallbacks: 'default' } : { ...apiBody, stream: true });
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      accept: 'text/event-stream',
    };
    if (fallbacks) headers['anthropic-beta'] = FALLBACK_BETA;
    const t0 = now();
    let text = '';
    let ttftMs = null;
    let stopReason = null;
    let usage = null;
    let refusal = false;
    const req = request({ hostname: API_HOST, path: '/v1/messages', method: 'POST', headers, signal }, (res) => {
      const status = res.statusCode ?? 0;
      res.setEncoding('utf8');
      if (status !== 200) {
        let err = '';
        res.on('data', (c) => { err += c; });
        res.on('end', () => reject(new Error(`anthropic ${status}: ${err.slice(0, 300)}`)));
        return;
      }
      const feed = createSseParser((event, json) => {
        if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
          if (ttftMs === null) ttftMs = now() - t0;
          text += json.delta.text;
          onText?.(json.delta.text, text);
        } else if (json.type === 'message_delta') {
          stopReason = json.delta?.stop_reason ?? stopReason;
          usage = json.usage ?? usage;
          if (stopReason === 'refusal') refusal = true;
        } else if (json.type === 'error') {
          reject(new Error(`anthropic stream error: ${json.error?.message ?? 'unknown'}`));
        }
      });
      res.on('data', feed);
      res.on('end', () => resolve({ text, stopReason, usage, refusal, ttftMs, totalMs: now() - t0, cold: false }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
