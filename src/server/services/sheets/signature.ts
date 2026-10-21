/**
 * The Apps Script push signature (T34; plan §9 Webhooks: `HMAC(secret, ts + "." + eventId + "." +
 * body)`, +/- 300 s). Shared by the webhook receiver, the generated script's documentation and the
 * tests. Pure: no I/O.
 *
 * Headers: `X-AuraLead-Key-Id` (which integration's secret), `X-AuraLead-Timestamp` (Unix seconds),
 * `X-AuraLead-Event-Id` (the delivery id, equal to the body's `eventId`) and
 * `X-AuraLead-Signature: v1=<64 hex>`. The signed message is the timestamp and event id as ASCII,
 * each followed by a dot, then the raw body bytes exactly as received.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SHEETS_SIGNATURE_HEADERS = {
  keyId: 'X-AuraLead-Key-Id',
  timestamp: 'X-AuraLead-Timestamp',
  eventId: 'X-AuraLead-Event-Id',
  signature: 'X-AuraLead-Signature',
} as const;

export const SHEETS_SIGNATURE_VERSION = 'v1';
/** Allowed clock skew between the script and the server, either way. */
export const SHEETS_REPLAY_WINDOW_SECONDS = 300;

export const SHEETS_KEY_ID_RE = /^as_[A-Za-z0-9_-]{8,64}$/;
export const SHEETS_TIMESTAMP_RE = /^\d{1,12}$/;
export const SHEETS_EVENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SIGNATURE_RE = /^v1=([0-9a-f]{64})$/;

export function sheetsSigningMessage(timestamp: string, eventId: string, raw: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${timestamp}.${eventId}.`, 'utf8'), raw]);
}

export function signSheetsPush(secret: string, timestamp: string, eventId: string, raw: Buffer): string {
  return `${SHEETS_SIGNATURE_VERSION}=${createHmac('sha256', Buffer.from(secret, 'utf8')).update(sheetsSigningMessage(timestamp, eventId, raw)).digest('hex')}`;
}

/** Constant-time check of a `v1=<hex>` header; a malformed header or an empty secret never verifies. */
export function verifySheetsSignature(secret: string, timestamp: string, eventId: string, raw: Buffer, header: string): boolean {
  if (!secret) return false;
  const m = SIGNATURE_RE.exec(header);
  if (!m) return false;
  const expected = createHmac('sha256', Buffer.from(secret, 'utf8')).update(sheetsSigningMessage(timestamp, eventId, raw)).digest();
  return timingSafeEqual(expected, Buffer.from(m[1]!, 'hex'));
}

/** True when the timestamp lies within the replay window of `now`. */
export function withinReplayWindow(timestamp: string, now: Date): boolean {
  if (!SHEETS_TIMESTAMP_RE.test(timestamp)) return false;
  return Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp)) <= SHEETS_REPLAY_WINDOW_SECONDS;
}
