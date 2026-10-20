'use client';

/**
 * Decisions on one approval item (T22; 06-design F18, §11.3 "Approvals queue"; AT12 at the UI).
 *
 *  - Approve binds the version on screen (`expectedVersion`) and the workspace slug; approve-and-send
 *    also names the channel (and, for WhatsApp, the approved template). The server runs the T19
 *    transaction, idempotent per version and channel, and GatedAction ignores repeat clicks while a
 *    request is pending, so a double click is one request and a retry returns the same dispatch.
 *  - A stale item (409) shows "This item changed since you opened it" and nothing is reported as
 *    approved or sent.
 *  - Channels the server says cannot be used are gated with the server's reason (configuration or
 *    eligibility); the PDF must exist before a quotation is sent. Without the capability every
 *    decision is gated by permission (plan §12).
 *  - A channel that cannot be used is never pre-selected: the first usable channel is chosen, and
 *    when none is usable nothing is, so nothing looks ready that is not.
 *
 * Look (design spec §6): channel choices are pills with the channel icon in its category color; a
 * chosen pill is aura when usable and amber with a lock when it is not. The view has one primary
 * button (GlowFrame): the send action when it can run; when sending is blocked but approving is
 * not, "Approve vN" takes that place and comes first, and the blocked send follows with its reason.
 */
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { CircleAlert, CircleCheck, Clock, Lock, Mail, MessageCircle, Send, XCircle } from 'lucide-react';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { useCsrfToken } from '@/components/patterns/csrf';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { GlowFrame } from '@/components/visual/GlowFrame';
import { postAction } from '@/components/inbox/api';

export const STALE_MESSAGE = 'This item changed since you opened it. Reload to see the current version.';

export type ActionChannel = {
  channel: 'WHATSAPP' | 'EMAIL';
  gate: Gate | null;
  templates: Array<{ id: string; name: string; language: string }>;
  /** Deferrable reasons (pauses, internal cap): the send is queued and waits. */
  deferredLabels: string[];
};

export type ApprovalActionsProps = {
  approvalId: string;
  workspaceSlug: string;
  workspaceName: string;
  kind: 'QUOTE_VERSION' | 'OUTBOUND_MESSAGE';
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'INVALIDATED';
  /** What the dialogs and toasts call the item, e.g. "Q-0003 v2" or "Email draft". */
  label: string;
  versionNo: number | null;
  isCurrent: boolean;
  pdfReady: boolean;
  channels: ActionChannel[];
  permissions: { canDecide: boolean; canSend: boolean };
};

type ChannelKey = ActionChannel['channel'];

const NO_DECIDE: Gate = { category: 'permission', reason: 'Your assignment in this workspace does not include approving.' };
const NO_SEND: Gate = { category: 'permission', reason: 'Your assignment in this workspace does not include approving and sending.' };
const NO_CHANNEL: Gate = { category: 'eligibility', reason: 'No channel can send this quotation yet. Each channel above says why.' };
const CHANNEL_WORDS = { EMAIL: 'by email', WHATSAPP: 'on WhatsApp' } as const;
const CHANNEL_LOOK: Record<ChannelKey, { name: string; icon: typeof Mail; iconClass: string }> = {
  EMAIL: { name: 'Email', icon: Mail, iconClass: 'text-ice' },
  WHATSAPP: { name: 'WhatsApp', icon: MessageCircle, iconClass: 'text-chart-3-hi' },
};

/** The channel chosen on first render: a quotation with a choice starts on its first usable channel, or none. */
function initialChannel(props: ApprovalActionsProps): ChannelKey | null {
  const choosable = props.kind === 'QUOTE_VERSION' && props.channels.length > 1;
  if (!choosable) return props.channels[0]?.channel ?? 'EMAIL';
  return props.channels.find((c) => c.gate === null)?.channel ?? null;
}

export function ApprovalActions(props: ApprovalActionsProps) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const groupId = useId();
  const [channel, setChannel] = useState<ChannelKey | null>(() => initialChannel(props));
  const selected = props.channels.find((c) => c.channel === channel) ?? null;
  const [templateId, setTemplateId] = useState(selected?.templates[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<{ message: string; reference: string | null } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const isQuote = props.kind === 'QUOTE_VERSION';
  const open = props.status === 'PENDING' || (isQuote && props.status === 'APPROVED');

  async function run(path: 'approve' | 'send' | 'reject', body: Record<string, unknown>, success: string): Promise<{ ok: true } | { ok: false; message: string; reference: string | null }> {
    setFailure(null);
    setDone(null);
    const res = await postAction(`/api/app/approvals/${props.approvalId}/${path}`, { workspaceSlug: props.workspaceSlug, ...body }, csrf);
    if (!res.ok) {
      const message = res.status === 409 ? STALE_MESSAGE : res.message;
      setFailure({ message, reference: res.reference });
      return { ok: false, message, reference: res.reference };
    }
    toast.success(success);
    setDone(success);
    router.refresh();
    return { ok: true };
  }

  let approveGate: Gate | null = null;
  if (!props.permissions.canDecide) approveGate = NO_DECIDE;
  else if (!props.isCurrent) approveGate = { category: 'eligibility', reason: 'A newer version replaced this one. Open the current version to approve it.' };

  let sendGate: Gate | null = null;
  if (!props.permissions.canSend) sendGate = NO_SEND;
  else if (!props.isCurrent) sendGate = { category: 'eligibility', reason: 'A newer version replaced this one.' };
  else if (channel === null) sendGate = NO_CHANNEL;
  else if (selected?.gate) sendGate = selected.gate;
  else if (isQuote && !props.pdfReady) sendGate = { category: 'eligibility', reason: 'The quotation PDF is still being prepared. This page refreshes on its own.' };
  else if (channel === 'WHATSAPP' && isQuote && templateId === '') sendGate = { category: 'configuration', reason: 'Choose the approved template that carries the quotation.' };

  const verb = props.status === 'APPROVED' ? 'Send' : 'Approve and send';
  const sendLabel = channel === null ? verb : `${verb} ${CHANNEL_WORDS[channel]}`;

  function sendBody(): Record<string, unknown> {
    if (!isQuote) return {};
    return { expectedVersion: props.versionNo, channel, ...(channel === 'WHATSAPP' && templateId ? { templateId } : {}) };
  }

  if (!open) return null;

  const canApproveHere = isQuote && props.status === 'PENDING';
  // When the send cannot run but approving can, approving is the action to take: it leads the row.
  const approveLeads = canApproveHere && sendGate !== null && approveGate === null;
  const approveAction = canApproveHere ? (
    <GatedAction
      label={`Approve v${props.versionNo ?? ''}`}
      pendingLabel="Approving..."
      variant={approveLeads ? 'default' : 'outline'}
      icon={<CircleCheck aria-hidden="true" />}
      gate={approveGate}
      onAction={async () => {
        await run('approve', { expectedVersion: props.versionNo }, `${props.label} approved.`);
      }}
    />
  ) : null;

  const sendAction = (
    <GatedAction
      label={sendLabel}
      pendingLabel="Queuing..."
      icon={<Send aria-hidden="true" />}
      gate={sendGate}
      onAction={async () => {
        if (channel === null) return;
        await run('send', sendBody(), `${props.label} ${props.status === 'APPROVED' ? 'queued' : 'approved and queued'} ${CHANNEL_WORDS[channel]}.`);
      }}
    />
  );

  return (
    <div className="flex flex-col gap-4" data-approval-actions>
      {isQuote && props.channels.length > 1 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-fg-1">Send the quotation</legend>
          <div className="flex flex-wrap gap-2">
            {props.channels.map((c) => {
              const look = CHANNEL_LOOK[c.channel];
              const ChannelIcon = look.icon;
              const usable = c.gate === null;
              return (
                <label
                  key={c.channel}
                  data-channel-usable={usable ? 'true' : 'false'}
                  className={cn(
                    'flex min-h-11 cursor-pointer items-center gap-2 rounded-full border bg-bg-2 py-1.5 pr-3.5 pl-3 text-sm text-fg-1 transition-[border-color,background-color] duration-fast',
                    // 44px tall below 1024px (touch target), 40px on desktop.
                    'lg:min-h-10',
                    // Keyboard focus rings the whole pill (the radio inside is small and round).
                    'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-aura has-[:focus-visible]:outline-solid',
                    usable
                      ? 'border-border-strong hover:border-aura/45 has-[:checked]:border-aura has-[:checked]:bg-aura/10'
                      : 'border-dashed border-border-input hover:border-warning/50 has-[:checked]:border-solid has-[:checked]:border-warning/60 has-[:checked]:bg-warning/10',
                  )}
                >
                  <input
                    type="radio"
                    name={`${groupId}-channel`}
                    value={c.channel}
                    checked={channel === c.channel}
                    className="size-4 accent-[var(--accent)] focus-visible:outline-none"
                    onChange={() => {
                      setChannel(c.channel);
                      setTemplateId(c.templates[0]?.id ?? '');
                    }}
                  />
                  <ChannelIcon aria-hidden="true" className={cn('size-4 shrink-0', look.iconClass)} />
                  {look.name}
                  {usable ? null : (
                    <span className="inline-flex items-center gap-1 text-xs text-fg-2">
                      <Lock aria-hidden="true" className="size-3" />
                      (unavailable)
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}
      {channel === 'WHATSAPP' && isQuote && selected && selected.templates.length > 0 ? (
        <div className="flex max-w-sm flex-col gap-1.5">
          <Label htmlFor={`${groupId}-template`} className="text-fg-2">
            WhatsApp template
          </Label>
          <NativeSelect id={`${groupId}-template`} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {selected.templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.language})
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : null}
      {selected && selected.deferredLabels.length > 0 && sendGate === null ? (
        <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-xs text-fg-1">
          <Clock aria-hidden="true" className="mt-px size-3.5 shrink-0 text-warning" />
          The send will wait: {selected.deferredLabels.join('; ')}.
        </p>
      ) : null}

      <div className="flex flex-wrap items-start gap-2">
        {approveLeads ? null : sendGate === null ? <GlowFrame>{sendAction}</GlowFrame> : sendAction}
        {approveAction ? approveLeads ? <GlowFrame>{approveAction}</GlowFrame> : approveAction : null}
        {props.status === 'PENDING' ? (
          props.permissions.canDecide ? (
            <ConfirmDialog
              trigger={
                <Button variant="ghost">
                  <XCircle aria-hidden="true" />
                  Reject
                </Button>
              }
              title={`Reject ${props.label}?`}
              description="The item leaves the queue and nothing is sent. The reason is kept in the audit log."
              confirmLabel="Reject item"
              pendingLabel="Rejecting..."
              workspaceName={props.workspaceName}
              destructive
              onConfirm={async () => {
                if (reason.trim().length < 3) return { ok: false, message: 'Give a reason of at least 3 characters.' };
                return run('reject', { reason: reason.trim() }, `${props.label} rejected.`);
              }}
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${groupId}-reason`} className="text-fg-1">
                  Reason
                </Label>
                <Textarea id={`${groupId}-reason`} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
              </div>
            </ConfirmDialog>
          ) : (
            <GatedAction label="Reject" variant="ghost" gate={NO_DECIDE} onAction={() => setReason('')} />
          )
        ) : null}
      </div>
      {approveLeads ? sendAction : null}

      {failure ? (
        <p role="alert" className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-fg-1">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
          <span>
            {failure.message}
            {failure.reference ? <span className="block text-xs text-fg-2">Reference: {failure.reference}</span> : null}
          </span>
        </p>
      ) : null}
      {done ? (
        <p role="status" className="flex items-start gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-fg-1">
          <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
          {done}
        </p>
      ) : null}
    </div>
  );
}
