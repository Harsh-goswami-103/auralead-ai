/**
 * SectionTitle: a SectionCard title with a small tinted icon chip, the admin twin of the client
 * panel's ChipTitle, so section headings read the same way in every panel. The chip is decorative
 * (aria-hidden); the heading's accessible name is the text alone. Hues are brand hues only, chosen
 * by what the section is about: `panel` (this panel's flare) for delivery and provider traffic,
 * `volt` for the worker and its jobs, `ice` for stored data, `aura` for audit history. Never a
 * status hue (status lives in chips with labels) and never the AI violet. Server-safe.
 */
import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

export type SectionHue = 'panel' | 'volt' | 'ice' | 'aura';

const CHIP: Readonly<Record<SectionHue, string>> = {
  panel: 'bg-panel/14 text-panel ring-panel/30',
  volt: 'bg-volt-hi/16 text-volt-hi ring-volt-hi/30',
  ice: 'bg-ice/10 text-ice ring-ice/25',
  aura: 'bg-aura/14 text-aura ring-aura/25',
};

export function SectionTitle(props: { icon: ReactNode; hue?: SectionHue; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2.5">
      <span aria-hidden="true" className={cn('inline-flex size-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset [&>svg]:size-4', CHIP[props.hue ?? 'panel'])}>
        {props.icon}
      </span>
      <span className="min-w-0">{props.children}</span>
    </span>
  );
}
