'use client';

/**
 * ScrollRegion: a focusable, labelled scroll box (a long table, a JSON payload) that fades its
 * bottom edge only while more content is below. The fade sits outside the scrolled content, so it
 * never adds height or dims the last line of a box that fits, and it clears once the reader
 * reaches the end. It follows scrolling, resizing and <details> toggles inside; without
 * ResizeObserver (jsdom) it still checks on mount and on scroll. The fade is decorative
 * (aria-hidden) and only changes opacity (instant under reduced motion). The children render on
 * the server; only this wrapper is a client island.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

export function ScrollRegion(props: {
  label: string;
  children: ReactNode;
  /** Classes for the scrolling element (max height, overflow, padding, type). */
  className?: string;
  /** Classes for the outer wrapper (display, margins, borders). */
  wrapperClassName?: string;
  /** Gradient start color of the fade, matching the surface behind the content. */
  fadeClassName?: string;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const region = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = region.current;
    const outer = wrapper.current;
    if (!box || !outer) return;
    const update = () => {
      outer.dataset.more = box.scrollHeight - box.scrollTop - box.clientHeight > 2 ? 'true' : 'false';
    };
    update();
    box.addEventListener('scroll', update, { passive: true });
    box.addEventListener('toggle', update, true);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(update);
      observer.observe(box);
      if (box.firstElementChild) observer.observe(box.firstElementChild);
    }
    return () => {
      box.removeEventListener('scroll', update);
      box.removeEventListener('toggle', update, true);
      observer?.disconnect();
    };
  }, []);

  return (
    <div ref={wrapper} data-more="false" className={cn('group/scroll relative min-w-0', props.wrapperClassName)}>
      <div ref={region} role="region" aria-label={props.label} tabIndex={0} className={cn('focus-visible:outline-offset-[-2px]', props.className)}>
        {props.children}
      </div>
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t to-transparent opacity-0 transition-opacity duration-base ease-enter group-data-[more=true]/scroll:opacity-100 motion-reduce:transition-none',
          props.fadeClassName ?? 'from-bg-1',
        )}
      />
    </div>
  );
}
