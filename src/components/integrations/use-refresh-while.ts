'use client';

/**
 * Re-reads the server-rendered page while the worker still has queued work for it: every 2 s five
 * times, then every 5 s six times, never in a hidden tab, then stops and reports `exhausted` so the
 * page can offer a manual refresh instead of polling forever. `runKey` restarts the schedule after a
 * new action.
 */
import { useEffect, useState } from 'react';

const SCHEDULE_MS: readonly number[] = [2000, 2000, 2000, 2000, 2000, 5000, 5000, 5000, 5000, 5000, 5000];

export function useRefreshWhile(active: boolean, refresh: () => void, runKey: number): { exhausted: boolean } {
  const [state, setState] = useState<{ key: string; step: number }>({ key: '', step: 0 });
  const key = `${runKey}:${active}`;
  const step = state.key === key ? state.step : 0;

  useEffect(() => {
    if (!active || step >= SCHEDULE_MS.length) return;
    const id = window.setTimeout(() => {
      if (document.visibilityState === 'visible') refresh();
      setState({ key, step: step + 1 });
    }, SCHEDULE_MS[step]);
    return () => window.clearTimeout(id);
  }, [active, step, key, refresh]);

  return { exhausted: active && step >= SCHEDULE_MS.length };
}
