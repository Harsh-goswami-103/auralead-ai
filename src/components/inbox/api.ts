/**
 * Browser helper for the inbox and approval actions (T22). Like the panel's `postJson`, it sends the
 * session CSRF header and never surfaces raw bodies or stacks; in addition it returns the error
 * `code` and the route's redacted `details`, because the composer and the approval queue act on them
 * (SEND_REFUSED with its next action, APPROVAL_CHANGED for a stale item).
 */
import { CSRF_HEADER_NAME } from '@/components/patterns/api-client';

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string | null; message: string; reference: string | null; details: Record<string, unknown> | null };

const NETWORK_MESSAGE = 'The server could not be reached. Check your connection and try again.';
const FALLBACK_MESSAGE = 'The request failed. Try again.';

export async function postAction<T = unknown>(url: string, body: unknown, csrfToken: string | null): Promise<ActionResult<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (csrfToken) headers[CSRF_HEADER_NAME] = csrfToken;
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body ?? {}), credentials: 'same-origin' });
  } catch {
    return { ok: false, status: 0, code: null, message: NETWORK_MESSAGE, reference: null, details: null };
  }
  const parsed = (await res.json().catch(() => null)) as unknown;
  if (res.ok) return { ok: true, data: parsed as T };
  const err = (parsed ?? {}) as { code?: unknown; message?: unknown; reference?: unknown; details?: unknown };
  return {
    ok: false,
    status: res.status,
    code: typeof err.code === 'string' ? err.code : null,
    message: typeof err.message === 'string' && err.message.length > 0 ? err.message : FALLBACK_MESSAGE,
    reference: typeof err.reference === 'string' ? err.reference : res.headers.get('x-request-id'),
    details: err.details !== null && typeof err.details === 'object' && !Array.isArray(err.details) ? (err.details as Record<string, unknown>) : null,
  };
}

/** A fresh idempotency key for one user submission (kept for retries of the same submission). */
export function newRequestKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
