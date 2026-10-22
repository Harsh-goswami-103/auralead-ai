'use client';

/**
 * Inbox composer (T22; 06-design F5, §11.3 "Composer send"; ADR-121, ADR-123 per-lead template
 * values; ADR-124 read-only after the handoff). Everything it says about sending comes from the
 * server: the window end (`windowEndsAt`), the eligibility reasons and, after a refusal, the next
 * action and the reason. The line "Final check happens at send" is always shown, and the window
 * line counts down against the server time it was rendered with (re-evaluated every 60 s), so
 * crossing the boundary switches the action to an approved template or review instead of a
 * free-form send.
 *
 * Send posts once per submission (GatedAction ignores repeat clicks while pending) with a request
 * key that a retry of the same text reuses, so the server queues one dispatch. A refusal keeps the
 * draft, shows the server's reason and switches the action; nothing is ever reported as sent here:
 * the thread shows "Queued" and then the provider's status as it arrives.
 *
 * Templates: the picker lists the workspace's approved templates. Each body position shows where
 * its value comes from: the lead's own value for lead and workspace sources (read-only, resolved by
 * the server with `resolveLeadTemplateVariables`, "missing" when the lead has none), or a field the
 * person fills (manual and other sources). The bubble preview fills both. The server resolves the
 * values again at send and refuses a missing one with its reason (TEMPLATE_VARIABLES_MISSING).
 *
 * `workspaceSlug` (operator inbox) names the assigned workspace in every request. `readOnly`
 * (an operator once the lead is handed over) replaces the composer with its reason.
 *
 * Aurora look (design spec §5-§6): shared field surfaces, the card's border takes the chat accent
 * while a field inside has focus, and the WhatsApp window gets a thin bar of the time left out of
 * 24 h, toned by what is left (over 6 h success, under 6 h warning, under 1 h danger). The bar is
 * decorative (the sentence above says the time in words), static, and moves only when the 60 s
 * re-evaluation does; its width is rounded so server and client render the same markup.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert, CircleCheck, Clock, FileText, Lock, Reply, Save, Send } from 'lucide-react';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { useCsrfToken } from '@/components/patterns/csrf';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/components/ui/cn';
import type { ComposerTemplate } from '@/server/services/messaging/inbox';
import { newRequestKey, postAction } from './api';
import { formatClockTime, formatDayMonth, remainingHint } from './format';

export type ComposerProps = {
  conversationId: string;
  channel: 'WHATSAPP' | 'EMAIL';
  timeZone: string;
  /** Server time when the page was rendered (ISO); the client keeps its offset to it. */
  serverNow: string;
  freeform: { eligible: boolean; deferrable: boolean; reasons: string[]; labels: string[]; windowEndsAt: string | null };
  templates: ComposerTemplate[];
  templateGate: Gate | null;
  permissions: { canSend: boolean; canDraft: boolean };
  /** The operator's assigned workspace (`[ws]` inbox); omitted in the client panel. */
  workspaceSlug?: string;
  /** Set when this person may no longer write in the thread (an operator after the handoff). */
  readOnly?: { reason: string } | null;
};

const REVIEWABLE = new Set(['WINDOW_CLOSED', 'TEMPLATE_NOT_APPROVED', 'NOT_CONFIGURED', 'QUALITY_PAUSED']);
const NO_SEND: Gate = { category: 'permission', reason: 'Your role can draft replies but not approve and send them. Save it for review instead.' };
const NO_DRAFT: Gate = { category: 'permission', reason: 'Your role cannot write messages in this workspace.' };
const MISSING_WORDS: Readonly<Record<string, string>> = { NO_VALUE: 'this lead has none', NOT_PROVIDED: 'type it', NEEDS_CONTEXT: 'type it', TOO_LONG: 'too long (200 characters at most)' };

const DAY_MS = 24 * 60 * 60 * 1000;

type Refusal = { message: string; reference: string | null; next: 'TEMPLATE' | 'REVIEW' | 'NONE' };
type Notice = { tone: 'info' | 'success'; text: string };

/**
 * The server's "now", advanced by the time the page has been open. Render reads only the server
 * time it was given (server and client markup match; no clock read during render); the 60 s tick
 * measures the client's offset to it after mount. A refresh with a newer server time restarts it.
 */
function useServerNow(serverNow: string): number {
  const rendered = new Date(serverNow).getTime();
  const [clock, setClock] = useState({ rendered, now: rendered });
  if (clock.rendered !== rendered) setClock({ rendered, now: rendered });
  useEffect(() => {
    const offset = rendered - Date.now();
    const id = window.setInterval(() => setClock((c) => (c.rendered === rendered ? { rendered, now: Date.now() + offset } : c)), 60_000);
    return () => window.clearInterval(id);
  }, [rendered]);
  return clock.rendered === rendered ? clock.now : rendered;
}

export function Composer(props: ComposerProps) {
  if (props.readOnly) {
    return (
      <section aria-label="Reply" className="flex items-start gap-2.5 rounded-xl border border-border-subtle bg-bg-1/80 p-3 text-sm text-fg-1 sm:p-4" data-composer-readonly>
        <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-2" />
        <span>
          {props.readOnly.reason}
          <span className="block text-xs text-fg-2">This conversation is read-only for operators.</span>
        </span>
      </section>
    );
  }
  return <ComposerForm {...props} />;
}

function ComposerForm(props: ComposerProps) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const now = useServerNow(props.serverNow);
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  const [templateId, setTemplateId] = useState(props.templates[0]?.id ?? '');
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [failure, setFailure] = useState<{ message: string; reference: string | null } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const keyRef = useRef<string | null>(null);

  const isWhatsApp = props.channel === 'WHATSAPP';
  const windowEnd = props.freeform.windowEndsAt ? new Date(props.freeform.windowEndsAt) : null;
  const closedOnClient = isWhatsApp && windowEnd !== null && now >= windowEnd.getTime();
  const serverBlocked = !props.freeform.eligible && !props.freeform.deferrable;
  const freeformBlocked = serverBlocked || closedOnClient || refusal !== null;
  const blockingReasons = closedOnClient && !serverBlocked ? ['WINDOW_CLOSED'] : props.freeform.reasons.filter((r) => r !== 'GLOBAL_PAUSED' && r !== 'CAP_REACHED');
  const reviewable = refusal ? refusal.next !== 'NONE' : blockingReasons.length > 0 && blockingReasons.every((r) => REVIEWABLE.has(r));
  const template = useMemo(() => props.templates.find((t) => t.id === templateId) ?? null, [props.templates, templateId]);
  const withSlug = (payload: Record<string, unknown>) => (props.workspaceSlug ? { ...payload, workspaceSlug: props.workspaceSlug } : payload);

  function edited() {
    keyRef.current = null;
    setRefusal(null);
    setFailure(null);
    setNotice(null);
  }

  function content(kind: 'TEXT' | 'TEMPLATE' | 'EMAIL'): Record<string, unknown> {
    if (kind === 'EMAIL') return { kind, subject, body };
    if (kind === 'TEMPLATE') {
      // Only the positions the person fills; lead and workspace values are resolved by the server.
      const typed = (template?.fields ?? []).filter((f) => f.editable).map((f) => [f.position, variables[f.position] ?? ''] as const);
      return { kind, templateId, variables: Object.fromEntries(typed) };
    }
    return { kind, body };
  }

  async function send(kind: 'TEXT' | 'TEMPLATE' | 'EMAIL') {
    setFailure(null);
    setNotice(null);
    if (kind !== 'TEMPLATE' && body.trim() === '') {
      setFailure({ message: 'Write a message first.', reference: null });
      return;
    }
    if (kind === 'EMAIL' && subject.trim() === '') {
      setFailure({ message: 'Write a subject first.', reference: null });
      return;
    }
    keyRef.current ??= newRequestKey();
    const res = await postAction<{ created: boolean; deferred: string[] | null }>('/api/app/messages', withSlug({ conversationId: props.conversationId, requestKey: keyRef.current, ...content(kind) }), csrf);
    if (res.ok) {
      keyRef.current = null;
      if (kind !== 'TEMPLATE') {
        setBody('');
        setSubject('');
      } else {
        setVariables({});
      }
      setRefusal(null);
      setNotice({ tone: 'success', text: res.data.deferred ? `Queued. It waits while: ${res.data.deferred.join('; ')}.` : 'Queued. The delivery status appears in the thread.' });
      router.refresh();
      return;
    }
    if (res.code === 'SEND_REFUSED') {
      const next = res.details?.next;
      keyRef.current = null;
      setRefusal({ message: res.message, reference: res.reference, next: next === 'TEMPLATE' || next === 'REVIEW' ? next : 'NONE' });
      router.refresh();
      return;
    }
    if (res.status === 422 || res.status === 409) keyRef.current = null;
    // A refusal with its own reason (a missing template value, a handed-over lead) or a network or
    // server failure: the reason is shown; an unanswered submission keeps its key, so a retry cannot send twice.
    setFailure({ message: res.message, reference: res.reference });
  }

  async function saveForReview() {
    setFailure(null);
    if (body.trim() === '' || (!isWhatsApp && subject.trim() === '')) {
      setFailure({ message: isWhatsApp ? 'Write a message first.' : 'Write a subject and a message first.', reference: null });
      return;
    }
    const res = await postAction('/api/app/messages/drafts', withSlug({ conversationId: props.conversationId, ...content(isWhatsApp ? 'TEXT' : 'EMAIL') }), csrf);
    if (!res.ok) {
      setFailure({ message: res.message, reference: res.reference });
      return;
    }
    setBody('');
    setSubject('');
    setRefusal(null);
    setNotice({ tone: 'success', text: 'Saved for review. It is in the approval queue and nothing was sent.' });
    router.refresh();
  }

  const sendGate: Gate | null = props.permissions.canSend ? null : NO_SEND;
  const templateGate: Gate | null = !props.permissions.canSend
    ? NO_SEND
    : (props.templateGate ?? (template?.notSendable ? { category: 'eligibility', reason: `This template ${template.notSendable.charAt(0).toLowerCase()}${template.notSendable.slice(1)}.` } : null));

  return (
    <section aria-label="Reply" className="flex min-w-0 flex-col gap-3 rounded-xl border border-border-subtle bg-bg-1/80 p-3 transition-colors duration-fast focus-within:border-chat-accent/50 sm:p-4">
      <EligibilityLine {...props} now={now} closedOnClient={closedOnClient} refusal={refusal} />

      {!isWhatsApp ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`subject-${props.conversationId}`} className="text-fg-1">
            Subject
          </Label>
          <Input
            id={`subject-${props.conversationId}`}
            value={subject}
            maxLength={200}
            onChange={(e) => {
              setSubject(e.target.value);
              edited();
            }}
          />
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`message-${props.conversationId}`} className="text-fg-1">
          Message
        </Label>
        <Textarea
          id={`message-${props.conversationId}`}
          className="min-h-24 resize-y placeholder:text-fg-3"
          value={body}
          maxLength={isWhatsApp ? 4096 : 10_000}
          placeholder={isWhatsApp ? 'Write a WhatsApp reply' : 'Write an email'}
          onChange={(e) => {
            setBody(e.target.value);
            edited();
          }}
        />
      </div>

      {refusal ? (
        <p role="alert" className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-fg-1">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            {refusal.message} Your text is kept.
            {refusal.next === 'TEMPLATE' ? ' Send an approved template instead.' : refusal.next === 'REVIEW' ? ' Save it for review, or send an approved template.' : ''}
            {refusal.reference ? <span className="block text-xs text-fg-2">Reference: {refusal.reference}</span> : null}
          </span>
        </p>
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
        <p role="status" className="flex items-start gap-2 text-sm text-success">
          <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{notice.text}</span>
        </p>
      ) : null}

      <div className="flex flex-wrap items-start gap-2">
        {!freeformBlocked ? (
          <GatedAction label="Send" pendingLabel="Queuing..." icon={<Send aria-hidden="true" />} gate={sendGate} onAction={() => send(isWhatsApp ? 'TEXT' : 'EMAIL')} />
        ) : null}
        {(freeformBlocked && reviewable) || !props.permissions.canSend ? (
          <GatedAction label="Save for review" pendingLabel="Saving..." variant={freeformBlocked ? 'default' : 'outline'} icon={<Save aria-hidden="true" />} gate={props.permissions.canDraft ? null : NO_DRAFT} onAction={saveForReview} />
        ) : null}
      </div>

      {isWhatsApp ? (
        <fieldset className="flex flex-col gap-3 border-t border-border-subtle pt-3">
          <legend className="flex items-center gap-1.5 pt-1 text-sm font-medium text-fg-1">
            <FileText aria-hidden="true" className="size-4 text-fg-2" />
            Approved template
          </legend>
          {props.templates.length > 0 ? (
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="flex min-w-0 flex-col gap-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`template-${props.conversationId}`} className="text-fg-2">
                    Template
                  </Label>
                  <NativeSelect
                    id={`template-${props.conversationId}`}
                    wrapperClassName="w-full"
                    value={templateId}
                    onChange={(e) => {
                      setTemplateId(e.target.value);
                      setVariables({});
                      setFailure(null);
                    }}
                  >
                    {props.templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.language}, {t.category.toLowerCase()})
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                {(template?.fields ?? []).map((f) =>
                  f.editable ? (
                    <div key={f.position} className="flex flex-col gap-1.5">
                      <Label htmlFor={`var-${props.conversationId}-${f.position}`} className="text-fg-2">
                        {`{{${f.position}}}`} {f.sourceLabel}
                      </Label>
                      <Input
                        id={`var-${props.conversationId}-${f.position}`}
                        value={variables[f.position] ?? ''}
                        maxLength={200}
                        onChange={(e) => {
                          setVariables((prev) => ({ ...prev, [f.position]: e.target.value }));
                          setFailure(null);
                          keyRef.current = null;
                        }}
                      />
                    </div>
                  ) : (
                    <div key={f.position} className="flex flex-col gap-0.5 text-sm" data-template-field={f.position}>
                      <span className="text-fg-2">
                        {`{{${f.position}}}`} {f.sourceLabel}, from the lead
                      </span>
                      {f.value !== null ? (
                        <span className="text-fg-1">{f.value}</span>
                      ) : (
                        <span className="flex items-center gap-1 text-warning">
                          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
                          Missing: {MISSING_WORDS[f.missing ?? 'NO_VALUE']}
                        </span>
                      )}
                    </div>
                  ),
                )}
              </div>
              {template ? <TemplateBubblePreview template={template} typed={variables} /> : null}
            </div>
          ) : null}
          <div>
            <GatedAction label="Send approved template" pendingLabel="Queuing..." variant="outline" icon={<Send aria-hidden="true" />} gate={templateGate} onAction={() => send('TEMPLATE')} />
          </div>
        </fieldset>
      ) : null}
    </section>
  );
}

/** The template as the customer will see it, with the lead's values and what the person typed. */
function TemplateBubblePreview({ template, typed }: { template: ComposerTemplate; typed: Record<string, string> }) {
  const p = template.preview;
  const body = p.body.replace(/\{\{\s*(\d+)\s*\}\}/g, (all, n: string) => (typed[String(Number(n))]?.trim() ? typed[String(Number(n))]!.trim() : all));
  return (
    <figure className="flex min-w-0 flex-col gap-1 rounded-lg bg-chat-wallpaper p-3" data-template-preview>
      <figcaption className="text-xs text-fg-2">Preview</figcaption>
      <div className="flex max-w-full flex-col gap-1 self-end rounded-lg rounded-tr-none bg-chat-bubble-out px-3 py-2">
        {p.headerFormat === 'DOCUMENT' && p.documentName ? (
          <span className="flex items-center gap-2 text-xs text-fg-1">
            <FileText aria-hidden="true" className="size-4 shrink-0 text-fg-2" />
            {p.documentName}
          </span>
        ) : null}
        {p.headerText ? <span className="text-sm font-semibold break-words text-fg-1">{p.headerText}</span> : null}
        <p className="text-sm break-words whitespace-pre-line text-fg-1">{body}</p>
        {p.footer ? <p className="text-xs text-chat-meta">{p.footer}</p> : null}
      </div>
      {p.buttons.map((b, i) => (
        <span key={`${b.type}:${i}`} className="flex items-center justify-center gap-1.5 self-end rounded-lg bg-chat-bubble-out px-3 py-1 text-sm text-aura">
          <Reply aria-hidden="true" className="size-3.5" />
          {b.text}
        </span>
      ))}
    </figure>
  );
}

function EligibilityLine(props: ComposerProps & { now: number; closedOnClient: boolean; refusal: Refusal | null }) {
  const end = props.freeform.windowEndsAt ? new Date(props.freeform.windowEndsAt) : null;
  const sameDay = end ? formatDayMonth(end, props.timeZone) === formatDayMonth(new Date(props.now), props.timeZone) : true;
  let line: string;
  let tone = 'text-fg-2';
  if (props.channel === 'WHATSAPP') {
    if (end && !props.closedOnClient && props.refusal === null) {
      line = `Free-form until ${formatClockTime(end, props.timeZone)}${sameDay ? '' : `, ${formatDayMonth(end, props.timeZone)}`} (${remainingHint(end.getTime() - props.now)}).`;
      tone = 'text-fg-1';
    } else if (props.freeform.reasons.includes('WINDOW_CLOSED') || props.closedOnClient || props.refusal !== null) {
      line = 'Free-form window closed. Send an approved template or save the reply for review.';
      tone = 'text-warning';
    } else {
      line = props.freeform.labels.length > 0 ? `${props.freeform.labels.join('. ')}.` : 'WhatsApp free-form replies need an open 24-hour window.';
      tone = 'text-warning';
    }
  } else {
    line = props.freeform.eligible ? 'Email can be sent to this contact.' : `${props.freeform.labels.join('. ')}.`;
    tone = props.freeform.eligible ? 'text-fg-1' : 'text-warning';
  }
  const showBar = props.channel === 'WHATSAPP' && end !== null && !props.closedOnClient && props.refusal === null;
  const left = end ? end.getTime() - props.now : 0;
  const fraction = Math.max(0.02, Math.min(1, left / DAY_MS));
  const barTone = left > 6 * 60 * 60 * 1000 ? 'bg-success' : left > 60 * 60 * 1000 ? 'bg-warning' : 'bg-danger';
  return (
    <div className="flex flex-col gap-1" data-composer-eligibility>
      <p className={cn('flex items-center gap-1.5 text-sm font-medium', tone)}>
        <Clock aria-hidden="true" className="size-4 shrink-0" />
        <span>{line}</span>
      </p>
      {showBar ? (
        <span aria-hidden="true" className="my-0.5 block h-1 w-full max-w-sm overflow-hidden rounded-full bg-bg-3">
          <span className={cn('block h-full rounded-full transition-[width] duration-slow ease-enter', barTone)} style={{ width: `${Math.round(fraction * 100)}%` }} />
        </span>
      ) : null}
      {props.freeform.deferrable ? <p className="text-xs text-warning">Sends will wait: {props.freeform.labels.join('; ')}.</p> : null}
      <p className="text-xs text-fg-2">Final check happens at send.</p>
    </div>
  );
}
