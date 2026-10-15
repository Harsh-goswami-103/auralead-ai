'use client';

/**
 * Re-reads the server-rendered page on an interval while the tab is visible (T22: "Queued, then live
 * status updates"; the worker's results appear without a manual reload). Client state such as an
 * unsent composer draft survives a refresh. Renders nothing.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export function AutoRefresh({ intervalMs }: { intervalMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, router]);
  return null;
}
