'use client';

/**
 * Lead console actions (T17). Every control posts to a /api/app/leads/[leadId]/** route with the
 * session CSRF token and shows the server's answer; nothing is decided in the browser. Gates come
 * from the server's capability answer (permission) and are shown with GatedAction (plan §12).
 *  - DraftActions: "Generate draft" (and "Generate with local template" when the last generation
 *    could not use a provider, C13), then waits for the worker's draft by re-reading the page and
 *    says so when the worker is late; "Create quote from proposal" for the newest draft that
 *    proposes services (the page's one primary action, framed by GlowFrame, unless a quotation
 *    is already waiting for approval: then approving it is the next step and leads instead).
 *  - QuoteApproveAction: approves the version on screen (409 when someone changed it meanwhile);
 *    primary (GlowFrame) for the newest draft quotation that can be approved, outline otherwise.
 *  - AutoRefresh: re-reads the page while the worker still has work for this lead: every 2 s at
 *    first, then less often, never while the tab is hidden, and it stops with a note after a few
 *    minutes instead of re-rendering a background page forever (usePolling).
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheck, Clock, FilePlus2, Loader2, PenLine, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { usePolling, type PollStep } from '@/components/leads/use-polling';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { GlowFrame } from '@/components/visual/GlowFrame';
import { ShimmerText } from '@/components/visual/ShimmerText';
import { FormAlert } from '../../../../user/pricing/fields';

/** Waiting for a requested draft: every 2 s for 30 s, then every 5 s for a minute. */
const DRAFT_WAIT_SCHEDULE: readonly PollStep[] = [
  { everyMs: 2_000, times: 15 },
  { everyMs: 5_000, times: 12 },
];

type Failure = { message: string; reference: string | null } | null;

/** Re-reads the server page while `active` (backing off, skipped in a hidden tab, capped). */
export function AutoRefresh({ active, label }: { active: boolean; label: string }) {
  const router = useRouter();
  const { exhausted } = usePolling(active, () => router.refresh());
  if (!active) return null;
  return (
    <p role="status" className="flex items-start gap-2 text-sm text-fg-2">
      {exhausted ? (
        <>
          <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
          Still waiting for the worker. Reload the page later; if it stays stuck, a super admin can check the job queue.
        </>
      ) : (
        <>
          <Loader2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-info motion-safe:animate-spin" />
          <ShimmerText>{label}</ShimmerText>
        </>
      )}
    </p>
  );
}

const permissionGate = (allowed: boolean, capability: string): Gate | null =>
  allowed ? null : { category: 'permission', reason: `Your assignment does not include ${capability}. Ask a super admin to grant it.` };

export function DraftActions(props: {
  leadId: string;
  workspaceSlug: string;
  latestDraftId: string | null;
  proposalDraftId: string | null;
  localGeneratorAvailable: boolean;
  permissions: { canGenerateDraft: boolean; canCreateQuote: boolean };
  /** False when another action on the page (approving a waiting quotation) is the primary one. */
  primary?: boolean;
}) {
  const router = useRouter();
  const csrfToken = useCsrfToken();
  const [failure, setFailure] = useState<Failure>(null);
  const [waitingSince, setWaitingSince] = useState<string | null | undefined>(undefined);

  // After a draft request: re-read until the worker's new draft is on the page; if it is late, say so.
  const waiting = waitingSince !== undefined && props.latestDraftId === waitingSince;
  const { exhausted } = usePolling(waiting, () => router.refresh(), DRAFT_WAIT_SCHEDULE);

  async function generate(local: boolean) {
    setFailure(null);
    const res = await postJson<{ jobId: string }>(`/api/app/leads/${props.leadId}/draft`, { workspaceSlug: props.workspaceSlug, local }, csrfToken);
    if (!res.ok) {
      setFailure({ message: res.message, reference: res.reference });
      return;
    }
    toast.success(local ? 'Local template draft requested.' : 'Draft requested.', { description: 'The worker is writing it now.' });
    setWaitingSince(props.latestDraftId);
    router.refresh();
  }

  async function createQuote() {
    if (!props.proposalDraftId) return;
    setFailure(null);
    const res = await postJson<{ quote: { number: string; currentVersionNo: number } }>(
      `/api/app/leads/${props.leadId}/quotes`,
      { workspaceSlug: props.workspaceSlug, draftId: props.proposalDraftId },
      csrfToken,
    );
    if (!res.ok) {
      setFailure({ message: res.message, reference: res.reference });
      return;
    }
    toast.success(`Quotation ${res.data.quote.number} v${res.data.quote.currentVersionNo} created as a draft.`);
    router.refresh();
  }

  const quoteGate = permissionGate(props.permissions.canCreateQuote, 'quotes.edit');
  const primary = props.primary ?? true;
  const createQuoteAction = (
    <GatedAction
      label="Create quote from proposal"
      pendingLabel="Creating..."
      variant={primary ? 'default' : 'outline'}
      icon={<FilePlus2 aria-hidden="true" />}
      gate={quoteGate}
      onAction={createQuote}
    />
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-3">
        {props.proposalDraftId ? quoteGate === null && primary ? <GlowFrame>{createQuoteAction}</GlowFrame> : createQuoteAction : null}
        <GatedAction
          label="Generate draft"
          pendingLabel="Requesting..."
          variant="outline"
          icon={<PenLine aria-hidden="true" />}
          gate={permissionGate(props.permissions.canGenerateDraft, 'drafts.generate')}
          onAction={() => generate(false)}
        />
        {props.localGeneratorAvailable ? (
          <GatedAction
            label="Generate with local template"
            pendingLabel="Requesting..."
            variant="outline"
            icon={<Wand2 aria-hidden="true" />}
            gate={permissionGate(props.permissions.canGenerateDraft, 'drafts.generate')}
            onAction={() => generate(true)}
          />
        ) : null}
      </div>
      {waiting ? (
        <p role="status" className="flex items-center gap-2 text-sm text-fg-2">
          {exhausted ? (
            <>
              <Clock aria-hidden="true" className="size-4 shrink-0 text-warning" />
              The worker has not written the draft yet. It appears here when ready.
            </>
          ) : (
            <>
              <Loader2 aria-hidden="true" className="size-4 shrink-0 text-info motion-safe:animate-spin" />
              <ShimmerText>Waiting for the worker to write the draft...</ShimmerText>
            </>
          )}
        </p>
      ) : null}
      {failure ? <FormAlert message={failure.message} reference={failure.reference} /> : null}
    </div>
  );
}

export function QuoteApproveAction(props: {
  leadId: string;
  quoteId: string;
  number: string;
  workspaceSlug: string;
  versionNo: number;
  gate: Gate | null;
  /** The page's primary action (GlowFrame); otherwise an outline button. */
  primary?: boolean;
}) {
  const router = useRouter();
  const csrfToken = useCsrfToken();
  const [failure, setFailure] = useState<Failure>(null);

  async function approve() {
    setFailure(null);
    const res = await postJson<{ quote: { number: string } }>(
      `/api/app/leads/${props.leadId}/quotes/${props.quoteId}/approve`,
      { workspaceSlug: props.workspaceSlug, expectedVersion: props.versionNo },
      csrfToken,
    );
    if (!res.ok) {
      setFailure({ message: res.message, reference: res.reference });
      return;
    }
    toast.success(`Quotation ${res.data.quote.number} v${props.versionNo} approved.`);
    router.refresh();
  }

  const approveAction = (
    <GatedAction
      label={`Approve v${props.versionNo}`}
      pendingLabel="Approving..."
      size="sm"
      variant={props.primary ? 'default' : 'outline'}
      icon={<CircleCheck aria-hidden="true" />}
      gate={props.gate}
      onAction={approve}
    />
  );

  return (
    <div className="flex flex-col gap-2">
      {props.primary && props.gate === null ? <GlowFrame className="self-start">{approveAction}</GlowFrame> : approveAction}
      {failure ? <FormAlert message={failure.message} reference={failure.reference} /> : null}
    </div>
  );
}
