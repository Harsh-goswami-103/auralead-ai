/**
 * A landing section's heading block: eyebrow with a hue dot, the h2 (Manrope, 30px from sm, solid
 * text: the page's one gradient is the hero keyword) and a short description. Each section keys
 * its dot to its own accent (how it works = aura, features = zest, ROI = volt, principles =
 * flare), echoing the cards below it; the label itself stays neutral text. It rises in once when
 * scrolled into view. Server-safe.
 */
import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';
import { Reveal } from '@/components/visual/Reveal';

export type SectionAccent = 'aura' | 'zest' | 'volt' | 'flare';

const DOT: Record<SectionAccent, string> = {
  aura: 'bg-aura ring-aura/20',
  zest: 'bg-zest ring-zest/20',
  volt: 'bg-volt-hi ring-volt-hi/25',
  flare: 'bg-flare ring-flare/20',
};

export function SectionIntro(props: {
  id: string;
  eyebrow: string;
  title: string;
  description?: ReactNode;
  align?: 'left' | 'center';
  accent?: SectionAccent;
  className?: string;
}) {
  const center = props.align === 'center';
  return (
    <Reveal inView className={cn('flex max-w-3xl flex-col gap-3', center && 'mx-auto items-center text-center', props.className)}>
      <p className="flex items-center gap-2.5 text-xs font-semibold tracking-[0.16em] text-fg-2 uppercase">
        <span aria-hidden="true" className={cn('size-1.5 rounded-full ring-4', DOT[props.accent ?? 'aura'])} />
        {props.eyebrow}
      </p>
      <h2 id={props.id} className="font-display text-[26px] leading-8 font-semibold tracking-[-0.02em] text-balance text-fg-1 sm:text-3xl">
        {props.title}
      </h2>
      {props.description ? <p className="max-w-2xl text-md text-pretty text-fg-2">{props.description}</p> : null}
    </Reveal>
  );
}
