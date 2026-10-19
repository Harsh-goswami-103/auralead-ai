'use client';

/**
 * Pauses decorative loops that nobody can see (design spec §2 ambient budget): sets
 * `data-paused="true"` on the element while it is offscreen or the tab is hidden, and visual.css
 * freezes every animation inside a paused element. DOM attributes only, no React state, so a
 * scroll never re-renders. Without IntersectionObserver (jsdom) only the tab visibility applies.
 */
import { useEffect, type RefObject } from 'react';

export function observePause(element: Element | null | undefined, rootMargin = '64px'): () => void {
  if (!element) return () => undefined;
  let onScreen = true;
  const apply = () => {
    if (onScreen && document.visibilityState !== 'hidden') element.removeAttribute('data-paused');
    else element.setAttribute('data-paused', 'true');
  };
  const observer =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) onScreen = entry.isIntersecting;
            apply();
          },
          { rootMargin },
        )
      : null;
  observer?.observe(element);
  document.addEventListener('visibilitychange', apply);
  apply();
  return () => {
    observer?.disconnect();
    document.removeEventListener('visibilitychange', apply);
    element.removeAttribute('data-paused');
  };
}

export function useInViewPause(ref: RefObject<Element | null>, options?: { rootMargin?: string }): void {
  const rootMargin = options?.rootMargin;
  useEffect(() => observePause(ref.current, rootMargin), [ref, rootMargin]);
}
