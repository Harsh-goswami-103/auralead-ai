'use client';

/**
 * Reveal, Stagger and StaggerItem (design spec §2-§3): one-time entrances for page headers,
 * sections, card grids and short lists. They are CSS keyframes (visual.css), not a JS motion loop,
 * so the entrance starts at first paint before hydration, never re-runs when data refetches, and
 * rests instantly under reduced motion (CSS media query, and these components drop the class once
 * the client reads the preference). Variants: rise (fadeRise, default: opacity 0, y 8), focus
 * (focusPull: y 12 + 6px blur, page h1 and hero only, at most 3 per view), fade. Stagger delays
 * its direct StaggerItem children 45ms apart (30ms for `step="list"`); only the first 8 move.
 * `inView` holds the first frame until the element scrolls into view (below-the-fold sections);
 * without IntersectionObserver (jsdom) it reveals at once. Never wrap tables or table rows.
 */
import { createElement, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/components/ui/cn';
import { usePrefersReducedMotion } from './use-prefers-reduced-motion';

export type RevealVariant = 'rise' | 'focus' | 'fade';
export type RevealTag = 'div' | 'section' | 'header' | 'footer' | 'article' | 'aside' | 'ul' | 'ol' | 'li' | 'p' | 'span' | 'h1' | 'h2' | 'h3';

type RevealProps = {
  children?: ReactNode;
  className?: string;
  /** Seconds before the entrance starts. */
  delay?: number;
  variant?: RevealVariant;
  as?: RevealTag;
  /** Wait until the element enters the viewport (for content below the fold). */
  inView?: boolean;
  id?: string;
};

function useReleaseWhenInView(enabled: boolean) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    const release = () => element.removeAttribute('data-reveal-wait');
    if (typeof IntersectionObserver !== 'function') {
      release();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        release();
        observer.disconnect();
      },
      { rootMargin: '0px 0px -40px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled]);
  return ref;
}

export function Reveal(props: RevealProps) {
  const reduced = usePrefersReducedMotion();
  const ref = useReleaseWhenInView(Boolean(props.inView) && !reduced);
  const variant = props.variant ?? 'rise';
  const style = !reduced && props.delay ? ({ '--reveal-delay': `${Math.round(props.delay * 1000)}ms` } as CSSProperties) : undefined;
  return createElement(
    props.as ?? 'div',
    {
      ref,
      id: props.id,
      style,
      'data-reveal': reduced ? 'static' : variant,
      'data-reveal-wait': !reduced && props.inView ? '' : undefined,
      className: cn(!reduced && 'visual-reveal', props.className),
    },
    props.children,
  );
}

export function Stagger(props: {
  children?: ReactNode;
  className?: string;
  as?: RevealTag;
  /** 'grid' = 45ms between items (cards), 'list' = 30ms (short lists of 12 or fewer). */
  step?: 'grid' | 'list';
  /** Seconds before the first item starts. */
  delay?: number;
  id?: string;
}) {
  const style = {
    '--stagger-step': props.step === 'list' ? '30ms' : '45ms',
    '--stagger-delay': `${Math.round((props.delay ?? 0.05) * 1000)}ms`,
  } as CSSProperties;
  return createElement(props.as ?? 'div', { id: props.id, style, 'data-stagger': '', className: cn('visual-stagger', props.className) }, props.children);
}

/** A direct child of Stagger; its delay comes from its position (first 8 animate). */
export function StaggerItem(props: Omit<RevealProps, 'delay'>) {
  return <Reveal {...props} />;
}
