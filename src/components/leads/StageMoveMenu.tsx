'use client';

/**
 * Moving a lead between sales stages (T26, R4): the "Move to stage" menu (the keyboard path: Enter
 * or Space opens it, arrows pick, Enter moves), the reason dialog LOST needs, and the hook every
 * stage control shares (table, Kanban card, Kanban drop, detail sheet).
 *
 * Each move posts `{ toStage, expectedStageVersion }` to /api/app/leads/[leadId]/stage with the
 * stageVersion the page was rendered with. The server decides: a stale version answers 409 and the
 * page re-reads itself to show where the lead is now, so a board never overwrites another
 * person's move or an automatic promotion. Nothing moves in the browser before the server agrees.
 */
import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRightLeft, ChevronDown, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/components/ui/cn';
import { SalesStage } from '@/lib/domain/enums';
import { LEAD_LOST_REASON_MIN, type LeadStageResult } from '@/lib/schemas/leads';
import { salesStageEntry } from './lead-vocabulary';
import type { StageLead } from './types';

export type StageMoveOutcome = { ok: true } | { ok: false; status: number; message: string; reference: string | null };

/** Posts one stage move and reports it; refreshes the page after a success or a conflict. */
export function useStageMove(workspaceSlug?: string) {
  const router = useRouter();
  const csrfToken = useCsrfToken();
  const [pendingLeadId, setPendingLeadId] = useState<string | null>(null);
  const running = useRef(false);

  /** `inline`: the caller shows a refusal itself (the LOST dialog), so no toast for it. */
  async function move(lead: StageLead, toStage: SalesStage, reason?: string, opts: { inline?: boolean } = {}): Promise<StageMoveOutcome> {
    if (running.current) return { ok: false, status: 0, message: 'Another move is still being saved.', reference: null };
    running.current = true;
    setPendingLeadId(lead.id);
    try {
      const res = await postJson<LeadStageResult>(
        `/api/app/leads/${encodeURIComponent(lead.id)}/stage`,
        { toStage, expectedStageVersion: lead.stageVersion, ...(reason ? { reason } : {}), ...(workspaceSlug ? { workspaceSlug } : {}) },
        csrfToken,
      );
      if (res.ok) {
        if (res.data.changed) toast.success(`Moved ${lead.displayName} to ${salesStageEntry(toStage).label}.`);
        router.refresh();
        return { ok: true };
      }
      if (res.status === 409) {
        toast.error(res.message, { description: 'The page now shows where the lead is.' });
        router.refresh();
      } else if (!opts.inline) {
        toast.error(res.message, { description: res.reference ? `Reference: ${res.reference}` : undefined });
      }
      return { ok: false, status: res.status, message: res.message, reference: res.reference };
    } finally {
      running.current = false;
      setPendingLeadId(null);
    }
  }

  return { move, pendingLeadId };
}

/** Why a lead is lost (required, audited with the move). Controlled: `lead` null means closed. */
export function LostReasonDialog(props: { lead: StageLead | null; onClose: () => void; onConfirm: (reason: string) => Promise<StageMoveOutcome> }) {
  const fieldId = useId();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const open = props.lead !== null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = reason.trim();
    if (trimmed.length < LEAD_LOST_REASON_MIN) {
      setError(`Write at least ${LEAD_LOST_REASON_MIN} characters.`);
      return;
    }
    setPending(true);
    setError(null);
    const outcome = await props.onConfirm(trimmed);
    setPending(false);
    if (outcome.ok || outcome.status === 409) {
      setReason('');
      props.onClose();
    } else setError(outcome.message);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) {
          setReason('');
          setError(null);
          props.onClose();
        }
      }}
    >
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Mark {props.lead?.displayName ?? 'this lead'} as lost</DialogTitle>
            <DialogDescription>The reason is kept in the audit history. You can reopen the lead later by moving it to another stage.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId}>Reason</Label>
            <Textarea
              id={fieldId}
              value={reason}
              maxLength={500}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${fieldId}-error` : undefined}
              onChange={(e) => setReason(e.target.value)}
              placeholder="For example: chose another clinic, budget postponed"
            />
            {error ? (
              <p id={`${fieldId}-error`} role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" aria-busy={pending || undefined}>
              {pending ? <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" /> : null}
              {pending ? 'Saving...' : 'Mark as lost'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The "Move to stage" menu of one lead. Every other stage is an item with its icon and label; LOST
 * opens the reason dialog first. The trigger's accessible name starts with its visible text.
 */
export function StageMoveMenu(props: { lead: StageLead; workspaceSlug?: string; size?: 'sm' | 'default'; className?: string }) {
  const { move, pendingLeadId } = useStageMove(props.workspaceSlug);
  const [lostFor, setLostFor] = useState<StageLead | null>(null);
  const pending = pendingLeadId === props.lead.id;
  const targets = SalesStage.filter((s) => s !== props.lead.salesStage);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size={props.size ?? 'sm'}
            aria-label={`Move to stage: ${props.lead.displayName}`}
            aria-busy={pending || undefined}
            data-stage-menu={props.lead.id}
            className={cn('gap-1.5', props.className)}
          >
            {pending ? <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" /> : <ArrowRightLeft aria-hidden="true" />}
            Move to stage
            <ChevronDown aria-hidden="true" className="opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuLabel>
            Now: <span className="font-medium text-fg-1">{salesStageEntry(props.lead.salesStage).label}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {targets.map((stage) => {
            const entry = salesStageEntry(stage);
            const Icon = entry.icon;
            return (
              <DropdownMenuItem
                key={stage}
                data-stage-target={stage}
                onSelect={() => {
                  if (stage === 'LOST') setLostFor(props.lead);
                  else void move(props.lead, stage);
                }}
              >
                <Icon aria-hidden="true" />
                {entry.label}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <LostReasonDialog lead={lostFor} onClose={() => setLostFor(null)} onConfirm={(reason) => move(props.lead, 'LOST', reason, { inline: true })} />
    </>
  );
}
