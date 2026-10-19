'use client';

/**
 * A zero-size client island that lets a server-rendered loop (AuroraBackdrop, Marquee, OrbitRing)
 * pause itself offscreen: drop it inside the looping element and it observes its parent with
 * useInViewPause's observer. Renders a hidden span and nothing else.
 */
import { useEffect, useRef } from 'react';
import { observePause } from './use-in-view-pause';

export function PauseOffscreen() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => observePause(ref.current?.parentElement), []);
  return <span ref={ref} hidden data-pause-probe="" />;
}
