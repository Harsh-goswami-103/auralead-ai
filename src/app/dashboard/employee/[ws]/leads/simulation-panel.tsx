'use client';

/**
 * DEMO source simulation controls for the lead console (T11, R11). Each button posts to
 * /api/demo/simulate/[source]; the server persists a provider-shaped event and the worker turns it
 * into leads, so the page re-reads the database afterwards and, while any event is still queued,
 * every two seconds until the worker has processed it. The gate (DEMO mode, leads.write) comes
 * from the server; blocked buttons stay focusable and say why (plan §12).
 */
import { useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileSpreadsheet, MapPin, Megaphone, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { Button } from '@/components/ui/button';
import { SIMULATION_SOURCE_LABELS, SIMULATION_SOURCES, type SimulationSource } from '@/lib/schemas/webhooks';

type SimulationGate = { allowed: true } | { allowed: false; category: 'mode' | 'permission'; reason: string };

type SimulateResponse = { records: number; events: Array<{ outcome: 'ACCEPTED' | 'DUPLICATE' }> };

const ICONS: Record<SimulationSource, typeof FileSpreadsheet> = { sheets: FileSpreadsheet, meta: Megaphone, gmaps: MapPin };

const DESCRIPTIONS: Record<SimulationSource, string> = {
  sheets: 'Form responses pushed by the Apps Script, with a WhatsApp consent answer on every other row.',
  meta: 'Instant Form leads, one webhook event per lead, with the form’s consent question.',
  gmaps: 'Businesses scraped by the Maps extension. Maps leads never carry WhatsApp consent.',
};

const POLL_MS = 2_000;

export function SimulationPanel({ workspaceSlug, gate, pending }: { workspaceSlug: string; gate: SimulationGate; pending: boolean }) {
  const router = useRouter();
  const csrfToken = useCsrfToken();
  const countId = useId();
  const [count, setCount] = useState(3);
  const blocked: Gate | null = gate.allowed ? null : { category: gate.category, reason: gate.reason };

  useEffect(() => {
    if (!pending) return undefined;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [pending, router]);

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
    <section aria-labelledby="simulate-heading" className="flex flex-col gap-4 rounded-xl border border-border-subtle bg-bg-1 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="simulate-heading" className="font-display text-lg font-semibold text-fg-1">
            Simulate a lead source
          </h2>
          <p className="max-w-prose text-sm text-fg-2">
            Sends a simulated delivery through the same webhook path and ingestion as a live source. Records are labelled Simulated and no provider is contacted.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor={countId} className="text-sm text-fg-2">
            Records
          </label>
          <select
            id={countId}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="h-9 rounded-md border border-border-strong bg-bg-2 px-2 text-sm text-fg-1"
          >
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <Button type="button" variant="ghost" size="sm" onClick={() => router.refresh()}>
            <RefreshCw aria-hidden="true" className="size-4" />
            Refresh
          </Button>
        </div>
      </div>
      <ul className="grid gap-3 md:grid-cols-3">
        {SIMULATION_SOURCES.map((source) => {
          const Icon = ICONS[source];
          return (
            <li key={source} className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-bg-2 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-fg-1">
                <Icon aria-hidden="true" className="size-4 text-fg-2" />
                {SIMULATION_SOURCE_LABELS[source]}
              </div>
              <p className="text-xs text-fg-2">{DESCRIPTIONS[source]}</p>
              <GatedAction label="Simulate" pendingLabel="Sending" gate={blocked} onAction={() => run(source)} size="sm" />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
