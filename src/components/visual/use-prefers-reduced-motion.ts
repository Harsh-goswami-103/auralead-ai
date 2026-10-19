'use client';

/**
 * The OS reduced-motion preference as a hydration-safe hook (design spec §0.6). The server and the
 * hydrating client both read `false`, then React re-renders with the real value, so markup never
 * mismatches; CSS (`@media (prefers-reduced-motion: reduce)` in visual.css) already shows the
 * resting frame before that. Guards jsdom and old browsers without matchMedia.
 */
import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function mediaQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null;
}

function subscribe(onChange: () => void): () => void {
  const query = mediaQuery();
  if (!query || typeof query.addEventListener !== 'function') return () => undefined;
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** True when the viewer asked for reduced motion; read it at call time outside React. */
export function prefersReducedMotion(): boolean {
  return mediaQuery()?.matches ?? false;
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}
