'use client';

/**
 * Runs one pricing mutation against /api/app/pricing/* with the session CSRF token. Success shows
 * the server-confirmed toast and re-reads the page from the database (router.refresh); failure
 * returns the route's user-facing message and reference so the form or dialog can show it.
 */
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';

export type MutationOutcome = { ok: true } | { ok: false; message: string; reference: string | null; status: number };

export function usePricingMutation() {
  const csrfToken = useCsrfToken();
  const router = useRouter();
  return async function mutate<T>(url: string, body: unknown, successMessage: (data: T) => string): Promise<MutationOutcome> {
    const res = await postJson<T>(url, body, csrfToken);
    if (!res.ok) return { ok: false, message: res.message, reference: res.reference, status: res.status };
    toast.success(successMessage(res.data));
    router.refresh();
    return { ok: true };
  };
}

export type VersionResult = { pricingVersion: { version: number } | null; versionCreated?: boolean };

/** "Saved as price list v4. Issued quotes unchanged." (06-design Pricing CRUD success copy). */
export function versionMessage(prefix: string, data: VersionResult): string {
  if (data.versionCreated !== false && data.pricingVersion) return `${prefix} Saved as price list v${data.pricingVersion.version}. Issued quotes unchanged.`;
  return `${prefix} Issued quotes keep their own copy.`;
}
