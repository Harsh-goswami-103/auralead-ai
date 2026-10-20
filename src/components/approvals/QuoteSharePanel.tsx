'use client';

/**
 * Quotation share controls (T22, P15, C2-C4, P16; 06-design §11.2 "User Quotations", §11.3 "Quote
 * share"). A link is created for the current version and its token is shown exactly once (the
 * server keeps only its hash), so "Copy link" exists right after creation. Copying a link of an
 * APPROVED quotation is the hand-over: only after the clipboard write succeeded is the quotation
 * marked sent (APPROVED -> SENT, sentVia MANUAL_LINK). "Mark as sent manually" covers a PDF handed
 * over through the business's own channel. Links can be revoked. View evidence counts browser opens
 * and never claims a person read the quotation.
 *
 * Aurora look (design spec §6): a section card with an icon chip, evidence and sent lines with their
 * icons, the one-time link in a box with a gradient edge, a Copy button whose icon turns into a
 * check for 1.5s after a successful copy (the single role=status line still announces it), and each
 * link's state as a pill with an icon (Active, Expired, Revoked, Replaced). On an approved quotation
 * that has no link yet, creating one is the view's next step, so it is the primary (GlowFrame)
 * action; once the link exists, Copy link takes that role.
 */
import { useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Check, CircleAlert, CircleCheck, Clock, Copy, Eye, History, Link2, Send, Unlink, type LucideIcon } from 'lucide-react';
import { IconChip } from '@/components/client/IconChip';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { useCsrfToken } from '@/components/patterns/csrf';
import { TONE_CLASSES, type StatusTone } from '@/components/patterns/status-vocabulary';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { fieldSurface } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { GlowFrame } from '@/components/visual/GlowFrame';
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
const STATE_STYLES: Record<string, { label: string; tone: StatusTone; icon: LucideIcon }> = {
  ACTIVE: { label: 'Active', tone: 'success', icon: Link2 },
  EXPIRED: { label: 'Expired', tone: 'warning', icon: Clock },
  REVOKED: { label: 'Revoked', tone: 'danger', icon: Unlink },
  SUPERSEDED: { label: 'Replaced by a newer version', tone: 'neutral', icon: History },
};

export function QuoteSharePanel(props: QuoteSharePanelProps) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const id = useId();
  const [expiry, setExpiry] = useState('');
  const [created, setCreated] = useState<{ url: string; expiresAt: string } | null>(null);
  const [failure, setFailure] = useState<{ message: string; reference: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);

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
    setCopied(true);
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

  // On an approved quotation the link is the next step: the primary action until one is created.
  // The wrapper depends only on the status, so creating a link never remounts (and unfocuses) it.
  const primaryShare = createGate === null && props.status === 'APPROVED';
  const createButton = (
    <GatedAction
      label="Create share link"
      pendingLabel="Creating..."
      variant={primaryShare && !created ? 'default' : 'outline'}
      icon={<Link2 aria-hidden="true" />}
      gate={createGate}
      onAction={createLink}
    />
  );

  return (
    <section aria-labelledby={`${id}-heading`} className="relative flex min-w-0 flex-col gap-4 rounded-xl border border-border-subtle bg-bg-1/80 p-4 sm:p-5">
      <div className="flex flex-col gap-2">
        <h2 id={`${id}-heading`} className="flex items-center gap-2.5 font-display text-lg font-semibold text-fg-1">
          <IconChip hue="ice">
            <Link2 />
          </IconChip>
          Share
        </h2>
        <p className="flex items-start gap-2 text-sm text-fg-2">
          <Eye aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-3" />
          <span className="text-pretty">
            {evidenceLine}
            {evidence.fetches > 0 ? ` Link loads, including previews: ${evidence.fetches}.` : ''}
          </span>
        </p>
        {sentLine ? (
          <p className="flex items-center gap-2 text-sm text-fg-1">
            <Send aria-hidden="true" className="size-4 shrink-0 text-info" />
            {sentLine}
          </p>
        ) : null}
        {evidence.openedWhileUnsent && props.status === 'APPROVED' ? (
          <p className="flex items-start gap-2 text-sm text-warning">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            A link was opened before this quotation was marked as sent. Mark it as sent?
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-48 flex-1 flex-col gap-1.5">
          <Label htmlFor={`${id}-expiry`} className="text-fg-2">
            Link expires
          </Label>
          <NativeSelect id={`${id}-expiry`} value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            <option value="">When the quotation expires</option>
            {EXPIRY_OPTIONS.map((d) => (
              <option key={d} value={String(d)}>
                In {d} {d === 1 ? 'day' : 'days'} (at most the validity)
              </option>
            ))}
          </NativeSelect>
        </div>
        {primaryShare ? <GlowFrame>{createButton}</GlowFrame> : createButton}
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
        <div className="rounded-xl bg-[linear-gradient(120deg,color-mix(in_oklab,var(--aura)_70%,transparent),color-mix(in_oklab,var(--volt-hi)_55%,transparent))] p-px motion-safe:animate-reveal-rise">
          <div className="flex flex-col gap-2 rounded-[calc(var(--r-xl)-1px)] bg-bg-1 p-3">
            <Label htmlFor={`${id}-url`} className="text-fg-1">
              Share link
            </Label>
            <div className="flex flex-wrap gap-2">
              <input
                id={`${id}-url`}
                readOnly
                value={created.url}
                onFocus={(e) => e.currentTarget.select()}
                className={cn(fieldSurface, 'h-9 min-w-0 flex-1 px-3 font-mono text-xs md:text-xs')}
              />
              <GatedAction
                label="Copy link"
                pendingLabel="Copying..."
                icon={copied ? <Check aria-hidden="true" key="copied" className="motion-safe:animate-reveal-focus" /> : <Copy aria-hidden="true" key="copy" />}
                gate={null}
                onAction={copyLink}
              />
            </div>
            <p className="text-xs text-fg-2">
              Shown once: only a fingerprint of this link is stored. Valid until {formatShortDateTime(new Date(created.expiresAt), props.timeZone)}.
              {props.status === 'APPROVED' ? ' Copying it marks the quotation as sent.' : ''}
            </p>
          </div>
        </div>
      ) : null}

      {failure ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-fg-1">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
          <span>
            {failure.message}
            {failure.reference ? <span className="block text-xs text-fg-2">Reference: {failure.reference}</span> : null}
          </span>
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="flex items-start gap-2 text-sm text-success">
          <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{notice}</span>
        </p>
      ) : null}

      {props.shares.length === 0 ? (
        <p className="text-sm text-fg-2">No links yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-lg border border-border-subtle bg-bg-2/30">
          {props.shares.map((s) => {
            const style = STATE_STYLES[s.state] ?? { label: s.state, tone: 'neutral' as const, icon: Link2 };
            const StateIcon = style.icon;
            return (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm" data-share-state={s.state}>
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className={cn('inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium', TONE_CLASSES[style.tone])}>
                      <StateIcon aria-hidden="true" className="size-3.5" />
                      {style.label}
                    </span>
                    {s.state === 'ACTIVE' ? <span className="text-xs text-fg-2">until {formatShortDateTime(new Date(s.expiresAt), props.timeZone)}</span> : null}
                  </span>
                  <span className="text-xs text-fg-3">Created {formatShortDateTime(new Date(s.createdAt), props.timeZone)}</span>
                </span>
                {s.state === 'ACTIVE' ? (
                  props.canShare ? (
                    <ConfirmDialog
                      trigger={
                        <Button variant="ghost" size="sm" className="text-fg-2 hover:bg-danger/10 hover:text-danger">
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
            );
          })}
        </ul>
      )}
    </section>
  );
}
