'use client';

/**
 * Runs one quote mutation against /api/app/quotes/* with the session CSRF token. Success shows the
 * server-confirmed toast and either navigates (a new quote) or re-reads the page from the database;
 * failure returns the route's user-facing message and reference for the form or dialog to show.
 */
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { isSafeRedirect, postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';

export type MutationOutcome = { ok: true } | { ok: false; message: string; reference: string | null; status: number };

export function useQuoteMutation() {
  const csrfToken = useCsrfToken();
  const router = useRouter();
  return async function mutate<T>(url: string, body: unknown, success: (data: T) => { message: string; redirectTo?: string }): Promise<MutationOutcome> {
    const res = await postJson<T>(url, body, csrfToken);
    if (!res.ok) return { ok: false, message: res.message, reference: res.reference, status: res.status };
    const { message, redirectTo } = success(res.data);
    toast.success(message);
    if (redirectTo && isSafeRedirect(redirectTo)) router.push(redirectTo);
    else router.refresh();
    return { ok: true };
  };
}
