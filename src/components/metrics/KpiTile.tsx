/**
 * One dashboard number (06-design §11.3 "Command center KPIs"): the StatTile look with the
 * metric's definition one click away ("How it's counted"). The value is final from the first
 * frame (no count-up, F11) and never colored. A widget whose query failed renders in place as
 * "Not available" with the request reference and a Retry that re-reads the page, while the other
 * tiles keep their numbers (the PARTIAL state). Server-safe; the popover and retry are client
 * islands.
 */
import type { ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { HUE_TILE, type BrandHue } from '@/components/patterns/hues';
import { StatTile, type StatTone } from '@/components/patterns/StatTile';
import { cn } from '@/components/ui/cn';
import { MetricInfo } from './MetricInfo';
import { RefreshButton } from './RefreshButton';

export type KpiState = { ok: true; value: ReactNode; hint?: ReactNode } | { ok: false; reference: string };

export function KpiTile(props: { label: string; definition: string; state: KpiState; icon: ReactNode; hue?: BrandHue; tone?: StatTone; className?: string }) {
  const { state } = props;
  if (!state.ok) {
    return (
      <StatTile
        label={props.label}
        value={<span className="font-sans text-base font-medium text-fg-2">Not available</span>}
        hint={<>Could not load this number. Reference {state.reference}</>}
        icon={<TriangleAlert />}
        tone="danger"
        footer={<RefreshButton size="sm" label="Retry" />}
        className={cn('h-full', props.className)}
      />
    );
  }
  return (
    <StatTile
      label={props.label}
      value={state.value}
      hint={state.hint}
      icon={props.icon}
      tone={props.tone}
      footer={<MetricInfo label={props.label} definition={props.definition} />}
      className={cn('h-full', props.hue ? HUE_TILE[props.hue] : null, props.className)}
    />
  );
}
