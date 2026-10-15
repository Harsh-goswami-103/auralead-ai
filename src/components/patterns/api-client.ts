/**
 * Browser helper for the panel's JSON mutations (`/api/app/*`, ADR-26). Sends the session's CSRF
 * token in the header withRoute checks, and turns any failure into the route's user-facing
 * message plus its reference (correlation ID). It never surfaces raw error bodies or stacks.
 */
export const CSRF_HEADER_NAME = 'x-csrf-token';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string; reference: string | null };

const NETWORK_MESSAGE = 'The server could not be reached. Check your connection and try again.';
const FALLBACK_MESSAGE = 'The request failed. Try again.';

export async function postJson<T = unknown>(url: string, body: unknown, csrfToken?: string | null): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (csrfToken) headers[CSRF_HEADER_NAME] = csrfToken;
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body ?? {}), credentials: 'same-origin' });
  } catch {
    return { ok: false, status: 0, message: NETWORK_MESSAGE, reference: null };
  }
  const parsed = (await res.json().catch(() => null)) as unknown;
  if (res.ok) return { ok: true, data: parsed as T };
  const err = (parsed ?? {}) as { message?: unknown; reference?: unknown };
  return {
    ok: false,
    status: res.status,
    message: typeof err.message === 'string' && err.message.length > 0 ? err.message : FALLBACK_MESSAGE,
    reference: typeof err.reference === 'string' ? err.reference : res.headers.get('x-request-id'),
  };
}

/** Follows a server-chosen same-origin path only (never an absolute or protocol-relative URL). */
export function isSafeRedirect(path: unknown): path is string {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\');
}
