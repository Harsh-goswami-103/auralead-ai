'use client';

/**
 * DEMO simulation for one lead source (T28, R11, AT2 UI path). Posts to
 * /api/demo/simulate/[source] with the workspace slug: the server persists a provider-shaped
 * delivery through the same webhook path as a live source and the worker turns it into leads, so
 * the page re-reads itself while the delivery is queued (`pending`, from the server) and shows the
 * result from the database. Gated on mode (LIVE has no simulators) or permission (`leads.write`).
 */
import { useCallback, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FlaskConical, Loader2, Play, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import type { SimulationSource } from '@/lib/schemas/webhooks';
import { useRefreshWhile } from './use-refresh-while';

type SimulateResponse = { records: number; events: Array<{ outcome: 'ACCEPTED' | 'DUPLICATE' }> };

const NOUN: Readonly<Record<SimulationSource, [string, string]>> = {
  sheets: ['form row', 'form rows'],
  meta: ['Instant Form lead', 'Instant Form leads'],
  gmaps: ['Maps record', 'Maps records'],
};

export function SourceSimulator(props: { source: SimulationSource; workspaceSlug: string; gate: Gate | null; pending: boolean; description: string }) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const countId = useId();
  const [count, setCount] = useState(3);
  const [runNo, setRunNo] = useState(0);
  const refresh = useCallback(() => router.refresh(), [router]);
  const { exhausted } = useRefreshWhile(props.pending, refresh, runNo);
  const [one, many] = NOUN[props.source];

  async function run() {
    const res = await postJson<SimulateResponse>(`/api/demo/simulate/${props.source}`, { workspaceSlug: props.workspaceSlug, count }, csrf);
    if (!res.ok) {
      toast.error(res.message, { description: res.reference ? `Reference ${res.reference}` : undefined });
      return;
    }
    const accepted = res.data.events.filter((e) => e.outcome === 'ACCEPTED').length;
    toast.success(`${res.data.records} simulated ${res.data.records === 1 ? one : many} received.`, {
      description: accepted > 0 ? 'The worker is normalizing and de-duplicating them now. No provider was contacted.' : 'Already received earlier; nothing new was created.',
    });
    setRunNo((n) => n + 1);
    router.refresh();
  }

  return (
    <div data-simulator={props.source} className="flex flex-col gap-3 rounded-xl border border-dashed border-demo/40 bg-demo/5 p-4">
      <div className="flex items-start gap-2.5">
        <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-demo" />
        <p className="text-sm text-fg-1">{props.description}</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <span className="flex flex-col gap-1">
          <label htmlFor={countId} className="text-xs text-fg-2">
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
        <GatedAction label="Simulate" pendingLabel="Sending..." variant="secondary" icon={<Play aria-hidden="true" />} gate={props.gate} onAction={run} />
        <Button type="button" variant="ghost" size="sm" onClick={() => router.refresh()}>
          <RefreshCw aria-hidden="true" />
          Refresh
        </Button>
      </div>
      {props.pending ? (
        <p role="status" className="flex items-center gap-2 text-sm text-fg-2">
          {exhausted ? (
            'The worker has not processed the queued delivery yet. Use Refresh to check again.'
          ) : (
            <>
              <Loader2 aria-hidden="true" className="size-4 shrink-0 text-info motion-safe:animate-spin" />
              The worker is processing the queued delivery. This page updates by itself.
            </>
          )}
        </p>
      ) : null}
    </div>
  );
}
