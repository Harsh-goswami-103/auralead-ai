'use client';

/**
 * Quotation share controls (T22, P15, C2-C4, P16; 06-design §11.2 "User Quotations", §11.3 "Quote
 * share"). A link is created for the current version and its token is shown exactly once (the
 * server keeps only its hash), so "Copy link" exists right after creation. Copying a link of an
 * APPROVED quotation is the hand-over: only after the clipboard write succeeded is the quotation
 * marked sent (APPROVED -> SENT, sentVia MANUAL_LINK). "Mark as sent manually" covers a PDF handed
 * over through the business's own channel. Links can be revoked. View evidence counts browser opens
 * and never claims a person read the quotation.
 */
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { CircleAlert, Copy, Link2, Send, Unlink } from 'lucide-react';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { useCsrfToken } from '@/components/patterns/csrf';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { postAction } from '@/components/inbox/api';
import { formatClockTime, formatShortDateTime } from '@/components/inbox/format';

export type ShareRow = { id: string; state: string; expiresAt: string; createdAt: string };

export type QuoteSharePanelProps = {
  quoteId: string;
  number: string;
  versionNo: number;
  /** Effective status (EXPIRED shown even before the sweep ran). */
  status: string;
  sentVia: 'DISPATCH' | 'MANUAL_LINK' | null;
  timeZone: string;
  shares: ShareRow[];
  evidence: { opens: number; lastOpenAt: string | null; fetches: number; openedWhileUnsent: boolean };
  canShare: boolean;
};

const NO_SHARE: Gate = { category: 'permission', reason: 'Your role cannot share quotations in this workspace.' };
const SHAREABLE = new Set(['APPROVED', 'SENT', 'VIEWED']);
const EXPIRY_OPTIONS = [1, 3, 7, 14, 30] as const;
const STATE_LABELS: Record<string, string> = { ACTIVE: 'Active', EXPIRED: 'Expired', REVOKED: 'Revoked', SUPERSEDED: 'Replaced by a newer version' };

export function QuoteSharePanel(props: QuoteSharePanelProps) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const id = useId();
  const [expiry, setExpiry] = useState('');
  const [created, setCreated] = useState<{ url: string; expiresAt: string } | null>(null);
  const [failure, setFailure] = useState<{ message: string; reference: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  let createGate: Gate | null = null;
  if (!props.canShare) createGate = NO_SHARE;
  else if (!SHAREABLE.has(props.status)) {
    createGate = {
      category: 'eligibility',
      reason: props.status === 'DRAFT' ? 'Approve this quotation before sharing it.' : 'Only an approved, sent or viewed quotation within its validity can be shared. Revise it to issue a new version.',
    };
  }

  async function createLink() {
    setFailure(null);
    setNotice(null);
    const res = await postAction<{ share: { expiresAt: string }; url: string }>(`/api/app/quotes/${props.quoteId}/shares`, expiry === '' ? {} : { expiresInDays: Number(expiry) }, csrf);
    if (!res.ok) {
      setFailure({ message: res.message, reference: res.reference });
      return;
    }
    setCreated({ url: res.data.url, expiresAt: res.data.share.expiresAt });
    router.refresh();
  }

  async function markSent(via: 'COPY_LINK' | 'MARK_SENT'): Promise<{ ok: true } | { ok: false; message: string; reference: string | null }> {
    const res = await postAction<{ changed: boolean }>(`/api/app/quotes/${props.quoteId}/mark-sent`, { expectedVersion: props.versionNo, via }, csrf);
    if (!res.ok) {
      setFailure({ message: res.message, reference: res.reference });
      return { ok: false, message: res.message, reference: res.reference };
    }
    router.refresh();
    return { ok: true };
  }

  async function copyLink() {
    if (!created) return;
    setFailure(null);
    setNotice(null);
    try {
      await navigator.clipboard.writeText(created.url);
    } catch {
      setFailure({ message: 'The browser could not copy the link. Select it in the box and copy it yourself, then use "Mark as sent manually".', reference: null });
      return;
    }
    if (props.status !== 'APPROVED') {
      setNotice('Link copied.');
      toast.success('Link copied.');
      return;
    }
    const outcome = await markSent('COPY_LINK');
    if (outcome.ok) {
      setNotice(`Link copied. ${props.number} is marked as sent (shared by link).`);
      toast.success(`${props.number} marked as sent.`);
    }
  }

  const sentLine =
    props.status === 'SENT' || props.status === 'VIEWED' || props.status === 'ACCEPTED'
      ? props.sentVia === 'MANUAL_LINK'
        ? 'Sent manually (link or PDF).'
        : props.sentVia === 'DISPATCH'
          ? 'Sent by the app.'
          : null
      : null;
  const evidence = props.evidence;
  const evidenceLine =
    evidence.opens > 0 && evidence.lastOpenAt
      ? `Link opened ${evidence.opens}x, last ${formatClockTime(new Date(evidence.lastOpenAt), props.timeZone)}. Opens do not confirm a person read it.`
      : 'Not opened yet. Opens do not confirm a person read it.';

  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-4 rounded-xl border border-border-subtle bg-bg-1 p-4">
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-heading`} className="flex items-center gap-2 text-lg font-semibold text-fg-1">
          <Link2 aria-hidden="true" className="size-4 text-fg-2" />
          Share
        </h2>
        <p className="text-sm text-fg-2">
          {evidenceLine}
          {evidence.fetches > 0 ? ` Link loads, including previews: ${evidence.fetches}.` : ''}
        </p>
        {sentLine ? <p className="text-sm text-fg-1">{sentLine}</p> : null}
        {evidence.openedWhileUnsent && props.status === 'APPROVED' ? <p className="text-sm text-warning">A link was opened before this quotation was marked as sent. Mark it as sent?</p> : null}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-expiry`} className="text-fg-2">
            Link expires
          </Label>
          <select id={`${id}-expiry`} value={expiry} onChange={(e) => setExpiry(e.target.value)} className="h-9 rounded-md border border-input bg-input/30 px-3 text-sm text-fg-1">
            <option value="">When the quotation expires</option>
            {EXPIRY_OPTIONS.map((d) => (
              <option key={d} value={String(d)}>
                In {d} {d === 1 ? 'day' : 'days'} (at most the validity)
              </option>
            ))}
          </select>
        </div>
        <GatedAction label="Create share link" pendingLabel="Creating..." variant="outline" icon={<Link2 aria-hidden="true" />} gate={createGate} onAction={createLink} />
        {props.status === 'APPROVED' ? (
          props.canShare ? (
            <ConfirmDialog
              trigger={
                <Button variant="outline">
                  <Send aria-hidden="true" />
                  Mark as sent manually
                </Button>
              }
              title={`Mark ${props.number} as sent?`}
              description="Use this when you handed the quotation over yourself (the PDF or a link through your own channel). It moves to Sent and the customer can accept it from a link."
              confirmLabel="Mark as sent"
              pendingLabel="Saving..."
              onConfirm={async () => {
                const outcome = await markSent('MARK_SENT');
                if (outcome.ok) toast.success(`${props.number} marked as sent.`);
                return outcome;
              }}
            />
          ) : (
            <GatedAction label="Mark as sent manually" variant="outline" gate={NO_SHARE} onAction={() => setNotice(null)} />
          )
        ) : null}
      </div>

      {created ? (
        <div className="flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <Label htmlFor={`${id}-url`} className="text-fg-1">
            Share link
          </Label>
          <div className="flex flex-wrap gap-2">
            <input id={`${id}-url`} readOnly value={created.url} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 rounded-md border border-input bg-bg-2 px-3 py-2 font-mono text-xs text-fg-1" />
            <GatedAction label="Copy link" pendingLabel="Copying..." icon={<Copy aria-hidden="true" />} gate={null} onAction={copyLink} />
          </div>
          <p className="text-xs text-fg-2">
            Shown once: only a fingerprint of this link is stored. Valid until {formatShortDateTime(new Date(created.expiresAt), props.timeZone)}.
            {props.status === 'APPROVED' ? ' Copying it marks the quotation as sent.' : ''}
          </p>
        </div>
      ) : null}

      {failure ? (
        <p role="alert" className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-fg-1">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
          <span>
            {failure.message}
            {failure.reference ? <span className="block text-xs text-fg-2">Reference: {failure.reference}</span> : null}
          </span>
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-success">
          {notice}
        </p>
      ) : null}

      {props.shares.length === 0 ? (
        <p className="text-sm text-fg-2">No links yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle">
          {props.shares.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm" data-share-state={s.state}>
              <span className="text-fg-1">
                Created {formatShortDateTime(new Date(s.createdAt), props.timeZone)} · {STATE_LABELS[s.state] ?? s.state}
                {s.state === 'ACTIVE' ? ` until ${formatShortDateTime(new Date(s.expiresAt), props.timeZone)}` : ''}
              </span>
              {s.state === 'ACTIVE' ? (
                props.canShare ? (
                  <ConfirmDialog
                    trigger={
                      <Button variant="ghost" size="sm">
                        <Unlink aria-hidden="true" />
                        Revoke
                      </Button>
                    }
                    title="Revoke this link?"
                    description="Anyone opening it will see that the link is not available. Other links keep working."
                    confirmLabel="Revoke link"
                    pendingLabel="Revoking..."
                    destructive
                    onConfirm={async () => {
                      const res = await postAction(`/api/app/quotes/${props.quoteId}/shares/${s.id}/revoke`, {}, csrf);
                      if (!res.ok) return { ok: false, message: res.message, reference: res.reference };
                      toast.success('Link revoked.');
                      router.refresh();
                      return { ok: true };
                    }}
                  />
                ) : (
                  <GatedAction label="Revoke" size="sm" variant="ghost" gate={NO_SHARE} onAction={() => setNotice(null)} />
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
