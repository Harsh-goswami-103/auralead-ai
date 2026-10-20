'use client';

/**
 * TiltCard (design spec §3, optional): a subtle 3D tilt (6deg by default, capped at 8deg so text
 * stays readable) with a soft glare, for landing feature cards only. Fine pointers only: touch and
 * pen input and reduced motion leave it flat. Angle math after Motion Primitives' tilt (MIT, see
 * THIRD_PARTY_NOTICES.md), re-implemented: angles go straight into CSS variables on the element
 * from the pointer handler (no springs, no React state); visual.css smooths them with a short
 * transition.
 */
import type { PointerEvent, ReactNode } from 'react';
import { cn } from '@/components/ui/cn';
import { prefersReducedMotion } from './use-prefers-reduced-motion';

export function TiltCard(props: { children: ReactNode; className?: string; maxTilt?: number }) {
  const max = Math.min(props.maxTilt ?? 6, 8);

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse' || prefersReducedMotion()) return;
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    element.style.setProperty('--tilt-x', `${(-y * max).toFixed(2)}deg`);
    element.style.setProperty('--tilt-y', `${(x * max).toFixed(2)}deg`);
    element.style.setProperty('--glare-x', `${Math.round((x + 0.5) * 100)}%`);
    element.style.setProperty('--glare-y', `${Math.round((y + 0.5) * 100)}%`);
    element.dataset.tilt = 'on';
  };
  const onPointerLeave = (event: PointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    element.style.setProperty('--tilt-x', '0deg');
    element.style.setProperty('--tilt-y', '0deg');
    element.removeAttribute('data-tilt');
  };

  return (
    <div data-tilt-card="" onPointerMove={onPointerMove} onPointerLeave={onPointerLeave} className={cn('visual-tilt rounded-xl', props.className)}>
      {props.children}
    </div>
  );
}
