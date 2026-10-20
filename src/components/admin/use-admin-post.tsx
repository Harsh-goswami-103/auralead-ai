'use client';

/**
 * The super admin's JSON mutations (T29): POST with the session's CSRF token, and the in-place
 * fresh sign-in the admin routes ask for (401 REAUTH_REQUIRED). In LIVE the person re-enters their
 * password (`/api/app/auth/reauth`); in DEMO the seeded personas have no password, so a fresh
 * persona sign-in is their authentication (ADR-64). Either way the session rotates: the new CSRF
 * token is used for the retry, and the page is refreshed so every other control on it gets the new
 * token too. Failures come back as the route's user-facing message and reference, never a raw body.
 */
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { CSRF_HEADER_NAME } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export type AdminPostResult<T = unknown> = { ok: true; data: T } | { ok: false; status: number; code: string | null; message: string; reference: string | null };

const NETWORK = 'The server could not be reached. Check your connection and try again.';

export async function adminPost<T = unknown>(url: string, body: unknown, csrf: string | null): Promise<AdminPostResult<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (csrf) headers[CSRF_HEADER_NAME] = csrf;
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body ?? {}), credentials: 'same-origin' });
  } catch {
    return { ok: false, status: 0, code: null, message: NETWORK, reference: null };
  }
  const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok) return { ok: true, data: parsed as T };
  return {
    ok: false,
    status: res.status,
    code: typeof parsed?.code === 'string' ? parsed.code : null,
    message: typeof parsed?.message === 'string' && parsed.message.length > 0 ? parsed.message : 'The request failed. Try again.',
    reference: typeof parsed?.reference === 'string' ? parsed.reference : res.headers.get('x-request-id'),
  };
}

export type AdminMode = 'demo' | 'live';

export function useAdminPost(mode: AdminMode) {
  const pageCsrf = useCsrfToken();
  const router = useRouter();
  const [csrf, setCsrf] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [reauthError, setReauthError] = useState<string | null>(null);
  const [reauthing, setReauthing] = useState(false);

  async function send<T = unknown>(url: string, body: unknown): Promise<AdminPostResult<T>> {
    const result = await adminPost<T>(url, body, csrf ?? pageCsrf);
    if (!result.ok && result.code === 'REAUTH_REQUIRED') setNeedsReauth(true);
    return result;
  }

  async function reauthenticate(password: string): Promise<boolean> {
    setReauthing(true);
    setReauthError(null);
    const result = mode === 'demo' ? await adminPost('/api/demo/session', { persona: 'admin' }, null) : await adminPost('/api/app/auth/reauth', { password }, csrf ?? pageCsrf);
    setReauthing(false);
    if (!result.ok) {
      setReauthError(result.message);
      return false;
    }
    const token = (result.data as { csrfToken?: unknown } | null)?.csrfToken;
    setCsrf(typeof token === 'string' ? token : null);
    setNeedsReauth(false);
    router.refresh();
    return true;
  }

  function resetReauth() {
    setNeedsReauth(false);
    setReauthError(null);
  }

  return { send, needsReauth, reauthError, reauthing, reauthenticate, resetReauth };
}

/** The in-place sign-in a fresh-authentication refusal asks for (password in LIVE, persona in DEMO). */
export function ReauthPanel(props: { mode: AdminMode; reauthing: boolean; error: string | null; onReauth: (password: string) => Promise<boolean> }) {
  const [password, setPassword] = useState('');
  const id = useId();
  async function confirm() {
    if (await props.onReauth(password)) setPassword('');
  }
  return (
    <div data-reauth-panel="" className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 p-3">
      <p className="flex items-center gap-2 text-sm text-fg-1">
        <KeyRound aria-hidden="true" className="size-4 shrink-0 text-warning" />
        This action needs a sign-in within the last 15 minutes.
      </p>
      {props.mode === 'live' ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-password`}>Your password</Label>
          <Input id={`${id}-password`} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="w-fit"
        disabled={props.reauthing || (props.mode === 'live' && password.length === 0)}
        onClick={() => void confirm()}
      >
        {props.reauthing ? 'Confirming...' : props.mode === 'demo' ? 'Sign in again as Super admin (DEMO)' : 'Confirm password'}
      </Button>
      {props.error ? (
        <p role="alert" className="text-sm text-danger">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}
