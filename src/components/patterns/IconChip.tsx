/**
 * A small tinted square holding a decorative lucide icon, in one of the aurora brand hues
 * (see hues.ts). aria-hidden: the text beside it always carries the meaning. Server-safe.
 */
import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';
import { HUE_CHIP, type BrandHue } from './hues';

export function IconChip(props: { children: ReactNode; hue?: BrandHue; size?: 'sm' | 'md'; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center ring-1 ring-inset',
        props.size === 'sm' ? 'size-7 rounded-md [&>svg]:size-3.5' : 'size-8 rounded-lg [&>svg]:size-4',
        HUE_CHIP[props.hue ?? 'aura'],
        props.className,
      )}
    >
      {props.children}
    </span>
  );
}

/** A SectionCard title with its icon chip; the heading's accessible name is the text alone. */
export function ChipTitle(props: { icon: ReactNode; hue?: BrandHue; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2.5">
      <IconChip hue={props.hue}>{props.icon}</IconChip>
      <span>{props.children}</span>
    </span>
  );
}
