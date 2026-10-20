'use client';

/**
 * DEMO source simulation controls for the lead console (T11, R11). Each button posts to
 * /api/demo/simulate/[source]; the server persists a provider-shaped event and the worker turns it
 * into leads, so the page re-reads the database afterwards and, while any event is still queued,
 * every two seconds (then less often, and never in a hidden tab) until the worker has processed
 * it. The gate (DEMO mode, leads.write) comes from the server; blocked buttons stay focusable and
 * say why (plan §12).
 *
 * Look (design spec §6): three source cards in the shared source palette (Sheets zest, Meta volt,
 * Maps aura): a colored hairline, a tinted icon tile and a corner wash; on hover or keyboard focus
 * the card lifts and a beam of its source color runs around the border.
 */
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileSpreadsheet, FlaskConical, Loader2, MapPin, Megaphone, Play, RefreshCw } from 'lucide-react';
import { ChipTitle } from '@/components/client/IconChip';
import { toast } from 'sonner';
import { usePolling } from '@/components/leads/use-polling';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { SectionCard } from '@/components/patterns/SectionCard';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { NativeSelect } from '@/components/ui/native-select';
import { BorderBeam } from '@/components/visual/BorderBeam';
import { ShimmerText } from '@/components/visual/ShimmerText';
import { SIMULATION_SOURCE_LABELS, SIMULATION_SOURCES, type SimulationSource } from '@/lib/schemas/webhooks';

type SimulationGate = { allowed: true } | { allowed: false; category: 'mode' | 'permission'; reason: string };

type SimulateResponse = { records: number; events: Array<{ outcome: 'ACCEPTED' | 'DUPLICATE' }> };

const ICONS: Record<SimulationSource, typeof FileSpreadsheet> = { sheets: FileSpreadsheet, meta: Megaphone, gmaps: MapPin };

const DESCRIPTIONS: Record<SimulationSource, string> = {
  sheets: 'Form responses pushed by the Apps Script, with a WhatsApp consent answer on every other row.',
  meta: 'Instant Form leads, one webhook event per lead, with the form’s consent question.',
  gmaps: 'Businesses scraped by the Maps extension. Maps leads never carry WhatsApp consent.',
};

/** Per-source tints from the shared source palette (patterns/source-style: chart-2 / chart-4 / chart-1). */
const TINTS: Record<SimulationSource, { bar: string; tile: string; icon: string; wash: string; hover: string; beam: [string, string] }> = {
  sheets: {
    bar: 'bg-chart-2-hi',
    tile: 'border-chart-2-hi/35 bg-chart-2/16',
    icon: 'text-chart-2-hi',
    wash: 'bg-[radial-gradient(120%_90%_at_100%_0%,color-mix(in_oklab,var(--chart-2-hi)_14%,transparent),transparent_60%)]',
    hover: 'hover:border-chart-2-hi/45 focus-within:border-chart-2-hi/45',
    beam: ['var(--chart-2-hi)', 'var(--aura)'],
  },
  meta: {
    bar: 'bg-chart-4-hi',
    tile: 'border-chart-4-hi/35 bg-chart-4/16',
    icon: 'text-chart-4-hi',
    wash: 'bg-[radial-gradient(120%_90%_at_100%_0%,color-mix(in_oklab,var(--chart-4-hi)_16%,transparent),transparent_60%)]',
    hover: 'hover:border-chart-4-hi/45 focus-within:border-chart-4-hi/45',
    beam: ['var(--chart-4-hi)', 'var(--ice)'],
  },
  gmaps: {
    bar: 'bg-chart-1-hi',
    tile: 'border-chart-1-hi/35 bg-chart-1/16',
    icon: 'text-chart-1-hi',
    wash: 'bg-[radial-gradient(120%_90%_at_100%_0%,color-mix(in_oklab,var(--chart-1-hi)_14%,transparent),transparent_60%)]',
    hover: 'hover:border-chart-1-hi/45 focus-within:border-chart-1-hi/45',
    beam: ['var(--chart-1-hi)', 'var(--zest)'],
  },
};

export function SimulationPanel({ workspaceSlug, gate, pending }: { workspaceSlug: string; gate: SimulationGate; pending: boolean }) {
  const router = useRouter();
  const csrfToken = useCsrfToken();
  const countId = useId();
  const [count, setCount] = useState(3);
  const blocked: Gate | null = gate.allowed ? null : { category: gate.category, reason: gate.reason };
  const { exhausted } = usePolling(pending, () => router.refresh());

  async function run(source: SimulationSource) {
    const res = await postJson<SimulateResponse>(`/api/demo/simulate/${source}`, { workspaceSlug, count }, csrfToken);
    if (!res.ok) {
      toast.error(res.message, { description: res.reference ? `Reference ${res.reference}` : undefined });
      return;
    }
    const accepted = res.data.events.filter((e) => e.outcome === 'ACCEPTED').length;
    toast.success(`${SIMULATION_SOURCE_LABELS[source]}: ${res.data.records} simulated ${res.data.records === 1 ? 'record' : 'records'} received.`, {
      description: accepted > 0 ? 'The worker is normalizing and de-duplicating them now.' : 'Already received earlier; nothing new was created.',
    });
    router.refresh();
  }

  return (
    <SectionCard
      accent
      title={
        <ChipTitle icon={<FlaskConical aria-hidden="true" />} hue="zest">
          Simulate a lead source
        </ChipTitle>
      }
      meta={
        <span className="block max-w-prose text-sm">
          Sends a simulated delivery through the same webhook path and ingestion as a live source. Records are labelled Simulated and no provider is contacted.
        </span>
      }
      actions={
        <>
          <span className="flex items-center gap-2">
            <label htmlFor={countId} className="text-sm text-fg-2">
              Records
            </label>
            <NativeSelect id={countId} value={count} onChange={(e) => setCount(Number(e.target.value))} wrapperClassName="w-20">
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </NativeSelect>
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => router.refresh()}>
            <RefreshCw aria-hidden="true" className="size-4" />
            Refresh
          </Button>
        </>
      }
    >
      <ul className="grid gap-3 md:grid-cols-3">
        {SIMULATION_SOURCES.map((source) => {
          const Icon = ICONS[source];
          const tint = TINTS[source];
          return (
            <li
              key={source}
              data-simulation-source={source}
              className={cn(
                'group relative isolate flex min-w-0 flex-col gap-3 overflow-hidden rounded-xl border border-border-subtle bg-bg-2/70 p-4',
                'transition-[translate,border-color] duration-fast ease-enter motion-safe:hover:-translate-y-0.5 motion-safe:focus-within:-translate-y-0.5',
                // The beam only runs while it is visible (hover or keyboard focus inside the card).
                '[&:not(:hover):not(:focus-within)_[data-visual-motion=beam]_*]:[animation-play-state:paused]',
                tint.hover,
              )}
            >
              <span aria-hidden="true" className={cn('pointer-events-none absolute inset-0 -z-10', tint.wash)} />
              <span aria-hidden="true" className={cn('pointer-events-none absolute inset-x-0 top-0 h-0.5 opacity-80', tint.bar)} />
              <BorderBeam
                colorFrom={tint.beam[0]}
                colorTo={tint.beam[1]}
                size={90}
                duration={6}
                className="opacity-0 transition-opacity duration-base group-focus-within:opacity-100 group-hover:opacity-100"
              />
              <div className="flex items-center gap-3">
                <span aria-hidden="true" className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg border', tint.tile)}>
                  <Icon className={cn('size-5', tint.icon)} />
                </span>
                <h3 className="text-sm font-semibold text-fg-1">{SIMULATION_SOURCE_LABELS[source]}</h3>
              </div>
              <p className="text-xs text-fg-2">{DESCRIPTIONS[source]}</p>
              <div className="mt-auto pt-1">
                <GatedAction
                  label="Simulate"
                  pendingLabel="Sending"
                  variant="secondary"
                  icon={<Play aria-hidden="true" className={tint.icon} />}
                  gate={blocked}
                  onAction={() => run(source)}
                  size="sm"
                />
              </div>
            </li>
          );
        })}
      </ul>
      {pending ? (
        <p role="status" className="flex items-center gap-2 text-sm text-fg-2">
          {exhausted ? (
            'The worker has not processed the queued events yet. Use Refresh to check again.'
          ) : (
            <>
              <Loader2 aria-hidden="true" className="size-4 shrink-0 text-info motion-safe:animate-spin" />
              <ShimmerText>The worker is processing queued events. This page updates by itself.</ShimmerText>
            </>
          )}
        </p>
      ) : null}
    </SectionCard>
  );
}
