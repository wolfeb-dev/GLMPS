// server/lib/kernel/tap-protocol.js
// The tap protocol version, read by both the server and the bundled tap so the
// two sides cannot disagree about the number.
export const TAP_PROTOCOL_HEADER = 'x-glmps-tap-protocol';
export const TAP_PROTOCOL = 1;
export const TAP_PROTOCOL_MIN = 1;

/** null when the header value is an integer at or above the minimum, else the 426 body. */
export function tapProtocolRefusal(headerValue) {
  const s = typeof headerValue === 'number' ? String(headerValue) : headerValue;
  const n = typeof s === 'string' && /^\d+$/.test(s) ? Number(s) : NaN;
  if (Number.isSafeInteger(n) && n >= TAP_PROTOCOL_MIN) return null;
  return { status: 426, error: 'tap-protocol-too-old', min: TAP_PROTOCOL_MIN, current: TAP_PROTOCOL };
}
