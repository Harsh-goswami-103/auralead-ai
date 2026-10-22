'use client';

/**
 * "Hand over to client" (ADR-124, lead-gen F5) on the operator's lead page. The dialog says what
 * will happen (stage, AI off, drafts withdrawn, pipeline stopped, the summary or why there is
 * none, and that the operator side becomes read-only), takes an optional note for the client and
 * posts `{ expectedStageVersion, note, requestKey, workspaceSlug }` with the session CSRF token.
 * One request key per opened dialog, so a retry after a network error cannot hand over twice. A
 * failure (409: someone changed the lead, or it was already handed over) stays in the dialog with
 * its reference and the page re-reads itself; success closes it, says so and re-reads the page.
 * Without `leads.handoff` (or for a lead that cannot be handed over) the control is a GatedAction
 * with the reason.
 */
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Handshake } from 'lucide-react';
import { toast } from 'sonner';
import { postJson } from '@/components/patterns/api-client';
import { ConfirmDialog, type ConfirmOutcome } from '@/components/patterns/ConfirmDialog';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { HANDOFF_NOTE_MAX, type HandOverResultDto } from '@/lib/schemas/handoff';
import { handoffEffects } from './handoff-vocabulary';

export const HAND_OVER_LABEL = 'Hand over to client';

function newRequestKey(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID().replace(/-/g, '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `handoff-${random}`.slice(0, 64);
}

export function HandOverDialog(props: {
  leadId: string;
  leadName: string;
  workspaceSlug: string;
  workspaceName: string;
  salesStage: string;
  stageVersion: number;
  summaryAvailable: boolean;
  gate: Gate | null;
}) {
  const router = useRouter();
  const csrfToken = useCsrfToken();
  const noteId = useId();
  const countId = useId();
  const [note, setNote] = useState('');
  const [requestKey, setRequestKey] = useState(newRequestKey);

  if (props.gate) return <GatedAction label={HAND_OVER_LABEL} icon={<Handshake aria-hidden="true" />} gate={props.gate} />;

  async function confirm(): Promise<ConfirmOutcome> {
    const res = await postJson<HandOverResultDto>(
      `/api/app/leads/${encodeURIComponent(props.leadId)}/handoff`,
      { workspaceSlug: props.workspaceSlug, expectedStageVersion: props.stageVersion, note: note.trim() === '' ? undefined : note.trim(), requestKey },
      csrfToken,
    );
    if (!res.ok) {
      if (res.status === 409) router.refresh();
      return { ok: false, message: res.message, reference: res.reference };
    }
    toast.success(`${props.leadName} was handed over to ${props.workspaceName}.`);
    setNote('');
    setRequestKey(newRequestKey());
    router.refresh();
    return { ok: true };
  }

  return (
    <ConfirmDialog
      trigger={
        <Button type="button" variant="secondary">
          <Handshake aria-hidden="true" />
          {HAND_OVER_LABEL}
        </Button>
      }
      title={`Hand over ${props.leadName} to the client?`}
      description="The client's team continues the conversation and the quotation. This is what happens now:"
      workspaceName={props.workspaceName}
      confirmLabel="Hand over"
      pendingLabel="Handing over..."
      onConfirm={confirm}
    >
      <ul aria-label="What happens" className="flex flex-col gap-1.5 text-sm text-fg-1">
        {handoffEffects({ salesStage: props.salesStage, summaryAvailable: props.summaryAvailable }).map((line) => (
          <li key={line} className="flex items-start gap-2">
            <ArrowRight aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-fg-3" />
            {line}
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={noteId} className="text-fg-1">
          Note for the client (optional)
        </Label>
        <Textarea
          id={noteId}
          name="note"
          value={note}
          maxLength={HANDOFF_NOTE_MAX}
          rows={4}
          aria-describedby={countId}
          placeholder="What the customer wants, what you promised, when to call."
          onChange={(e) => setNote(e.target.value)}
        />
        <span id={countId} className="text-xs text-fg-2">
          {note.length} of {HANDOFF_NOTE_MAX} characters. The client sees this note; it is not written to the audit trail.
        </span>
      </div>
    </ConfirmDialog>
  );
}
