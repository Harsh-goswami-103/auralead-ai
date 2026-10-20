'use client';

/**
 * The Marquee's pause control (WCAG 2.2.2 Pause, Stop, Hide): a strip of moving text needs a way
 * to stop it that works with a keyboard and on touch, not only on hover. It is a toggle button
 * (aria-pressed, a constant name) that sets data-user-paused on its strip, and visual.css freezes
 * the tracks while it is set. That is its own attribute: data-paused belongs to the offscreen
 * observer, which rewrites it whenever the strip scrolls in or out of view. Marquee renders it
 * once, beside the strip and outside both tracks. It is hidden under reduced motion, where the
 * strip is already a static row. DOM attribute only, like PauseOffscreen.
 */
import { useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function MarqueePauseButton(props: { label?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [paused, setPaused] = useState(false);

  function toggle() {
    const next = !paused;
    setPaused(next);
    ref.current?.parentElement?.querySelector('.visual-marquee')?.toggleAttribute('data-user-paused', next);
  }

  return (
    <Button
      ref={ref}
      type="button"
      variant="outline"
      size="icon-sm"
      aria-pressed={paused}
      onClick={toggle}
      data-marquee-pause=""
      className="rounded-full text-fg-2 hover:text-fg-1 aria-pressed:border-aura/45 aria-pressed:text-aura motion-reduce:hidden"
    >
      {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
      <span className="sr-only">{props.label ?? 'Pause scrolling'}</span>
    </Button>
  );
}
