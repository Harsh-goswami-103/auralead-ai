'use client';

/**
 * SpotlightCard (design spec §3): a card surface whose wash and border light up under the
 * pointer, in the panel hue at about 12%. Technique after Magic UI's magic-card (MIT, see
 * THIRD_PARTY_NOTICES.md), re-implemented: the pointer position goes straight into CSS variables
 * on the element (no React state per move); touch input is ignored, and the effect is cleared on
 * leave. User-initiated, so it is not an ambient loop; under reduced motion the fade is instant.
 * Defaults to the SectionCard surface; pass className to restyle.
 */
import type { PointerEvent, ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

type SpotlightTag = 'div' | 'article' | 'section' | 'li';

export function SpotlightCard(props: { children: ReactNode; className?: string; as?: SpotlightTag }) {
  const Tag = props.as ?? 'div';

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'touch') return;
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    element.style.setProperty('--spot-x', `${Math.round(event.clientX - rect.left)}px`);
    element.style.setProperty('--spot-y', `${Math.round(event.clientY - rect.top)}px`);
    element.dataset.spot = 'on';
  };
  const onPointerLeave = (event: PointerEvent<HTMLElement>) => {
    event.currentTarget.removeAttribute('data-spot');
  };

  return (
    <Tag
      data-spotlight=""
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      className={cn('visual-spotlight min-w-0 rounded-xl border border-border-subtle bg-bg-1/80', props.className)}
    >
      {props.children}
    </Tag>
  );
}
