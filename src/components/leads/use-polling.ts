'use client';

/**
 * usePolling: re-run `tick` (usually router.refresh) while `active`, the way the operator pages wait
 * for the worker. It skips ticks while the tab is hidden (a background tab does not re-render the
 * server page), and backs off: every 2 s for the first 20 s, every 5 s for the next minute, every
 * 10 s for three more, then it stops and reports `exhausted` so the page can say the worker is
 * late instead of polling forever. Re-activating starts a fresh schedule, and so does a new
 * `restartKey` while active (a second request after the schedule ran out polls again).
 */
import { useEffect, useRef, useState } from 'react';

export type PollStep = { everyMs: number; times: number };

export const WORKER_POLL_SCHEDULE: readonly PollStep[] = [
  { everyMs: 2_000, times: 10 },
  { everyMs: 5_000, times: 12 },
  { everyMs: 10_000, times: 18 },
];

export function usePolling(
  active: boolean,
  tick: () => void,
  schedule: readonly PollStep[] = WORKER_POLL_SCHEDULE,
  restartKey = 0,
): { exhausted: boolean } {
  const tickRef = useRef(tick);
  const [exhausted, setExhausted] = useState(false);

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  useEffect(() => {
    if (!active) return undefined;
    let phase = 0;
    let done = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const plan = () => {
      const step = schedule[phase];
      if (!step) {
        setExhausted(true);
        return;
      }
      timer = setTimeout(() => {
        const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
        if (!hidden) {
          tickRef.current();
          done += 1;
          if (done >= step.times) {
            phase += 1;
            done = 0;
          }
        }
        plan();
      }, step.everyMs);
    };
    plan();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      setExhausted(false);
    };
    // restartKey is not read inside: changing it only re-runs the effect (cleanup clears `exhausted`).
  }, [active, schedule, restartKey]);

  return { exhausted: active && exhausted };
}
