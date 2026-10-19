'use client';

/**
 * PageTransition (design spec §2-§3): when the pathname changes, the page content fades in and
 * rises 6px over 240ms (Web Animations API on the wrapper, started before paint). No exit
 * animation, so navigation is never delayed, and no remount: client state in nested layouts
 * survives. The first render does not animate (the server-rendered page is already visible and
 * its own Reveal entrances run), and nothing animates under reduced motion.
 */
import { usePathname } from 'next/navigation';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/components/ui/cn';
import { prefersReducedMotion } from './use-prefers-reduced-motion';

const KEYFRAMES: Keyframe[] = [
  { opacity: 0, transform: 'translateY(6px)' },
  { opacity: 1, transform: 'translateY(0)' },
];

export function PageTransition(props: { children: ReactNode; className?: string }) {
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);
  const shown = useRef(pathname);

  useLayoutEffect(() => {
    const element = ref.current;
    if (shown.current === pathname || !element) return;
    shown.current = pathname;
    if (typeof element.animate !== 'function' || prefersReducedMotion()) return;
    const animation = element.animate(KEYFRAMES, { duration: 240, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
    return () => animation.cancel();
  }, [pathname]);

  return (
    <div ref={ref} data-page-transition="" className={cn('min-w-0', props.className)}>
      {props.children}
    </div>
  );
}
