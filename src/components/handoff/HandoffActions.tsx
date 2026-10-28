'use client';

/**
 * Client controls of a handed-over lead (ADR-124, lead-gen F5):
 *  - AcknowledgeButton: the client's "Acknowledge" (POST /api/app/handoffs/[id]/acknowledge with the
 *    session CSRF token); the page re-reads itself afterwards, and a failure says so with its
 *    reference instead of pretending.
 *  - SummaryPendingRefresh: while the summary job is still writing, the page re-reads itself
 *    (backing off, never in a hidden tab, capped) and says so when the worker is late.
 */
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert, CircleCheck, Clock } from 'lucide-react';
import { toast } from 'sonner';
import { usePolling } from '@/components/leads/use-polling';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction } from '@/components/patterns/GatedAction';
import type { AcknowledgeResultDto } from '@/lib/schemas/handoff';

export function AcknowledgeButton(props: { handoffId: string; leadName: string }) {
  const router = useRouter();
  const csrfToken = useCsrfToken();
  const [failure, setFailure] = useState<{ message: string; reference: string | null } | null>(null);
  const root = useRef<HTMLSpanElement>(null);

  async function acknowledge() {
    setFailure(null);
    const res = await postJson<AcknowledgeResultDto>(`/api/app/handoffs/${encodeURIComponent(props.handoffId)}/acknowledge`, {}, csrfToken);
    if (!res.ok) {
      setFailure({ message: res.message, reference: res.reference });
      return;
    }
    toast.success(`You acknowledged ${props.leadName}.`);
    // This button goes away with the refresh: keep keyboard focus on the handover it belonged to.
    root.current?.closest<HTMLElement>('[data-handoff-id]')?.focus();
    router.refresh();
  }

  return (
    <span ref={root} className="inline-flex flex-col items-start gap-1.5">
      <GatedAction label="Acknowledge" pendingLabel="Acknowledging..." icon={<CircleCheck aria-hidden="true" />} gate={null} onAction={acknowledge} />
      {failure ? (
        <span role="alert" className="flex items-start gap-1.5 text-sm text-fg-1">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
          <span>
            {failure.message}
            {failure.reference ? <span className="block text-xs text-fg-2">Reference: {failure.reference}</span> : null}
          </span>
        </span>
      ) : null}
    </span>
  );
}

export function SummaryPendingRefresh(props: { active: boolean }) {
  const router = useRouter();
  const { exhausted } = usePolling(props.active, () => router.refresh());
  if (!props.active || !exhausted) return null;
  return (
    <p role="status" className="flex items-start gap-2 text-sm text-fg-2">
      <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
      The summary is taking longer than usual. Reload the page later; the note and the conversation are already here.
    </p>
  );
}
