'use client';

/**
 * "Sync templates" (T28, ADR-17): templates come from WhatsApp Manager, never authored here. In
 * DEMO the demo adapter plays WhatsApp Manager and adds the demo templates that are absent
 * (approved and rejected), labelled Simulated; in LIVE the button is gated until WhatsApp is
 * connected and verified. The result line says how many were added and that nothing was contacted.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';

type SyncResponse = { simulated: boolean; created: number; existing: number; updated: number; missing?: number };

export function TemplateSyncButton(props: { workspaceSlug: string; gate: Gate | null }) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const [line, setLine] = useState<{ text: string; role: 'status' | 'alert' } | null>(null);

  async function run() {
    setLine(null);
    const res = await postJson<SyncResponse>('/api/app/integrations/whatsapp/templates/sync', { workspaceSlug: props.workspaceSlug }, csrf);
    if (!res.ok) {
      setLine({ text: `${res.message}${res.reference ? ` Reference ${res.reference}.` : ''}`, role: 'alert' });
      return;
    }
    const { created, existing, updated, missing, simulated } = res.data;
    const changes = `${updated > 0 ? `, ${updated} updated` : ''}${missing ? `, ${missing} no longer listed in WhatsApp Manager (left unchanged)` : ''}`;
    const text = `${created} ${created === 1 ? 'template' : 'templates'} added, ${existing} already synced${changes}.${simulated ? ' Simulated, no provider contacted.' : ''}`;
    setLine({ text, role: 'status' });
    toast.success('Templates synced', { description: text });
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <GatedAction label="Sync templates" pendingLabel="Syncing..." variant="secondary" size="sm" icon={<RefreshCw aria-hidden="true" />} gate={props.gate} onAction={run} />
      {line ? (
        <p role={line.role} className="max-w-prose text-xs text-fg-2">
          {line.text}
        </p>
      ) : null}
    </div>
  );
}
