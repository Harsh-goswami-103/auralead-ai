'use client';

/**
 * The landing nav's in-page links with a scroll-spy (design spec §2: layoutId indicators). The
 * section that crosses a thin band just above the middle of the viewport is the current one: its
 * link gets aria-current and an aura pill that slides between links (Motion layoutId; the global
 * MotionConfig reducedMotion="user" turns the slide into a jump, and the pill then appears
 * without a fade). Nothing is marked on the server or before the observer reports, so the first
 * render is the same on server and client. Without IntersectionObserver (jsdom) no link is marked.
 */
import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { spring } from '@/components/motion/presets';
import { cn } from '@/components/ui/cn';
import { usePrefersReducedMotion } from '@/components/visual/use-prefers-reduced-motion';
import { LANDING_SECTIONS, type LandingSectionHref } from './sections';

function useCurrentSection(): LandingSectionHref | null {
  const [current, setCurrent] = useState<LandingSectionHref | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver !== 'function') return;
    const inBand = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) inBand.add(entry.target.id);
          else inBand.delete(entry.target.id);
        }
        setCurrent(LANDING_SECTIONS.find((s) => inBand.has(s.href.slice(1)))?.href ?? null);
      },
      { rootMargin: '-40% 0px -55% 0px' },
    );
    for (const section of LANDING_SECTIONS) {
      const element = document.getElementById(section.href.slice(1));
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);
  return current;
}

export function LandingNavLinks() {
  const current = useCurrentSection();
  const reduced = usePrefersReducedMotion();
  return (
    <ul className="ml-6 hidden items-center gap-1 md:flex">
      {LANDING_SECTIONS.map((s) => {
        const active = s.href === current;
        return (
          <li key={s.href}>
            <a
              href={s.href}
              aria-current={active ? 'true' : undefined}
              className={cn(
                'relative flex rounded-md px-3 py-2 text-sm transition-colors duration-fast ease-enter',
                active ? 'text-fg-1' : 'text-fg-2 hover:bg-bg-2/70 hover:text-fg-1',
              )}
            >
              {active ? (
                <motion.span
                  layoutId="landing-nav-pill"
                  transition={spring.smooth}
                  initial={reduced ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  aria-hidden="true"
                  className="absolute inset-0 rounded-md bg-aura/12 ring-1 ring-aura/30 ring-inset"
                >
                  <span className="absolute inset-x-3 -bottom-px h-px rounded-full bg-aura" />
                </motion.span>
              ) : null}
              <span className="relative">{s.label}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
