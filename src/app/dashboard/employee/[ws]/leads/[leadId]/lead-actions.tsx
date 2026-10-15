'use client';

/**
 * Lead console actions (T17). Every control posts to a /api/app/leads/[leadId]/** route with the
 * session CSRF token and shows the server's answer; nothing is decided in the browser. Gates come
 * from the server's capability answer (permission) and are shown with GatedAction (plan §12).
 *  - DraftActions: "Generate draft" (and "Generate with local template" when the last generation
 *    could not use a provider, C13), then waits for the worker's draft by re-reading the page;
 *    "Create quote from proposal" for the newest draft that proposes services.
 *  - QuoteApproveAction: approves the version on screen (409 when someone changed it meanwhile).
 *  - AutoRefresh: re-reads the page every 2 s while the worker still has work for this lead.
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheck, FilePlus2, Sparkles, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { FormAlert } from '../../../../user/pricing/fields';

const POLL_MS = 2_000;
const DRAFT_WAIT_POLLS = 45;

type Failure = { message: string; reference: string | null } | null;

/** Re-reads the server page every 2 s while `active`. */
export function AutoRefresh({ active, label }: { active: boolean; label: string }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, router]);
  if (!active) return null;
  return (
    <p role="status" className="text-sm text-fg-2">
      {label}
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
}) {
  const router = useRouter();
  const csrfToken = useCsrfToken();
  const [failure, setFailure] = useState<Failure>(null);
  const [waitingSince, setWaitingSince] = useState<string | null | undefined>(undefined);
  const polls = useRef(0);

  // After a draft request: re-read until the worker's new draft is on the page (or give up quietly).
  const waiting = waitingSince !== undefined && props.latestDraftId === waitingSince;
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(() => {
      polls.current += 1;
      if (polls.current > DRAFT_WAIT_POLLS) {
        setWaitingSince(undefined);
        return;
      }
      router.refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, router]);

  async function generate(local: boolean) {
    setFailure(null);
    const res = await postJson<{ jobId: string }>(`/api/app/leads/${props.leadId}/draft`, { workspaceSlug: props.workspaceSlug, local }, csrfToken);
    if (!res.ok) {
      setFailure({ message: res.message, reference: res.reference });
      return;
    }
    toast.success(local ? 'Local template draft requested.' : 'Draft requested.', { description: 'The worker is writing it now.' });
    polls.current = 0;
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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-3">
        <GatedAction
          label="Generate draft"
          pendingLabel="Requesting..."
          variant="outline"
          icon={<Sparkles aria-hidden="true" />}
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
        {props.proposalDraftId ? (
          <GatedAction
            label="Create quote from proposal"
            pendingLabel="Creating..."
            icon={<FilePlus2 aria-hidden="true" />}
            gate={permissionGate(props.permissions.canCreateQuote, 'quotes.edit')}
            onAction={createQuote}
          />
        ) : null}
      </div>
      {waiting ? (
        <p role="status" className="text-sm text-fg-2">
          Waiting for the worker to write the draft...
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

  return (
    <div className="flex flex-col gap-2">
      <GatedAction label={`Approve v${props.versionNo}`} pendingLabel="Approving..." size="sm" icon={<CircleCheck aria-hidden="true" />} gate={props.gate} onAction={approve} />
      {failure ? <FormAlert message={failure.message} reference={failure.reference} /> : null}
    </div>
  );
}
