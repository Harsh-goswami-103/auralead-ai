'use client';

/**
 * "Sync campaigns" (T35; P6): reads the ad account's campaigns and their last-7-days metrics. In
 * DEMO the demo stand-in for the Marketing API adds simulated campaigns (labelled Simulated, no
 * provider contacted); in LIVE the button is gated until Meta Lead Ads is verified with an ad
 * account. The result line names the currency the metrics are in (never converted).
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';

type SyncResponse = { simulated: boolean; currency: string; campaigns: number; snapshots: number; skipped: number; complete: boolean };

export function CampaignSyncButton(props: { workspaceSlug: string; gate: Gate | null }) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const [line, setLine] = useState<{ text: string; role: 'status' | 'alert' } | null>(null);

  async function run() {
    setLine(null);
    const res = await postJson<SyncResponse>('/api/app/campaigns/sync', { workspaceSlug: props.workspaceSlug }, csrf);
    if (!res.ok) {
      setLine({ text: `${res.message}${res.reference ? ` Reference ${res.reference}.` : ''}`, role: 'alert' });
      return;
    }
    const d = res.data;
    const text = `${d.campaigns} ${d.campaigns === 1 ? 'campaign' : 'campaigns'} and ${d.snapshots} metric ${d.snapshots === 1 ? 'window' : 'windows'} synced in ${d.currency}${d.skipped > 0 ? `, ${d.skipped} unreadable rows skipped` : ''}${d.complete ? '' : ', more than one sync reads (page limit)'}.${d.simulated ? ' Simulated, no provider contacted.' : ''}`;
    setLine({ text, role: 'status' });
    toast.success('Campaigns synced', { description: text });
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <GatedAction label="Sync campaigns" pendingLabel="Syncing..." variant="secondary" size="sm" icon={<RefreshCw aria-hidden="true" />} gate={props.gate} onAction={run} />
      {line ? (
        <p role={line.role} className="max-w-prose text-xs text-fg-2">
          {line.text}
        </p>
      ) : null}
    </div>
  );
}
