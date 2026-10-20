'use client';

/**
 * Inbox composer (T22; 06-design F5, §11.3 "Composer send"). Everything it says about sending comes
 * from the server: the window end (`windowEndsAt`), the eligibility reasons and, after a refusal,
 * the next action. The line "Final check happens at send" is always shown, and the window line is
 * re-evaluated every 60 s against the server time it was rendered with, so crossing the boundary
 * switches the action to an approved template or review instead of a free-form send.
 *
 * Send posts once per submission (GatedAction ignores repeat clicks while pending) with a request
 * key that a retry of the same text reuses, so the server queues one dispatch. A refusal keeps the
 * draft, shows the reason and switches the action; nothing is ever reported as sent here: the
 * thread shows "Queued" and then the provider's status as it arrives.
 *
 * Aurora look (design spec §5-§6): shared field surfaces, the card's border takes the aura hue while
 * a field inside has focus, and the WhatsApp window gets a thin bar of the time left out of 24 h,
 * toned by what is left (over 6 h success, under 6 h warning, under 1 h danger). The bar is
 * decorative (the sentence above says the time in words), static, and moves only when the 60 s
 * re-evaluation does; its width is rounded so server and client render the same markup.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert, CircleCheck, Clock, FileText, Save, Send } from 'lucide-react';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { useCsrfToken } from '@/components/patterns/csrf';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/components/ui/cn';
import { newRequestKey, postAction } from './api';
import { formatClockTime, formatDayMonth, remainingHint } from './format';

export type ComposerProps = {
  conversationId: string;
  channel: 'WHATSAPP' | 'EMAIL';
  timeZone: string;
  /** Server time when the page was rendered (ISO); the client keeps its offset to it. */
  serverNow: string;
  freeform: { eligible: boolean; deferrable: boolean; reasons: string[]; labels: string[]; windowEndsAt: string | null };
  templates: Array<{ id: string; name: string; language: string; category: string; variables: string[] }>;
  templateGate: Gate | null;
  permissions: { canSend: boolean; canDraft: boolean };
};

const REVIEWABLE = new Set(['WINDOW_CLOSED', 'TEMPLATE_NOT_APPROVED', 'NOT_CONFIGURED', 'QUALITY_PAUSED']);
const NO_SEND: Gate = { category: 'permission', reason: 'Your role can draft replies but not approve and send them. Save it for review instead.' };
const NO_DRAFT: Gate = { category: 'permission', reason: 'Your role cannot write messages in this workspace.' };

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

  function edited() {
    keyRef.current = null;
    setRefusal(null);
    setFailure(null);
    setNotice(null);
  }

  function content(kind: 'TEXT' | 'TEMPLATE' | 'EMAIL'): Record<string, unknown> {
    if (kind === 'EMAIL') return { kind, subject, body };
    if (kind === 'TEMPLATE') return { kind, templateId, variables: Object.fromEntries((template?.variables ?? []).map((v) => [v, variables[v] ?? ''])) };
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
    const res = await postAction<{ created: boolean; deferred: string[] | null }>('/api/app/messages', { conversationId: props.conversationId, requestKey: keyRef.current, ...content(kind) }, csrf);
    if (res.ok) {
      keyRef.current = null;
      setBody('');
      setSubject('');
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
    // Network or server failure: the same submission keeps its key, so a retry cannot send twice.
    setFailure({ message: res.message, reference: res.reference });
  }

  async function saveForReview() {
    setFailure(null);
    if (body.trim() === '' || (!isWhatsApp && subject.trim() === '')) {
      setFailure({ message: isWhatsApp ? 'Write a message first.' : 'Write a subject and a message first.', reference: null });
      return;
    }
    const res = await postAction('/api/app/messages/drafts', { conversationId: props.conversationId, ...content(isWhatsApp ? 'TEXT' : 'EMAIL') }, csrf);
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
  const templateGate: Gate | null = !props.permissions.canSend ? NO_SEND : props.templateGate;

  return (
    <section aria-label="Reply" className="flex min-w-0 flex-col gap-3 rounded-xl border border-border-subtle bg-bg-1/80 p-3 transition-colors duration-fast focus-within:border-aura/40 sm:p-4">
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
        <fieldset className="flex flex-col gap-2 border-t border-border-subtle pt-3">
          <legend className="flex items-center gap-1.5 pt-1 text-sm font-medium text-fg-1">
            <FileText aria-hidden="true" className="size-4 text-fg-2" />
            Approved template
          </legend>
          {props.templates.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`template-${props.conversationId}`} className="text-fg-2">
                  Template
                </Label>
                <NativeSelect id={`template-${props.conversationId}`} wrapperClassName="w-full" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                  {props.templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.language}, {t.category.toLowerCase()})
                    </option>
                  ))}
                </NativeSelect>
              </div>
              {(template?.variables ?? []).map((v) => (
                <div key={v} className="flex flex-col gap-1.5">
                  <Label htmlFor={`var-${props.conversationId}-${v}`} className="text-fg-2">
                    Variable {v}
                  </Label>
                  <Input id={`var-${props.conversationId}-${v}`} value={variables[v] ?? ''} onChange={(e) => setVariables((prev) => ({ ...prev, [v]: e.target.value }))} />
                </div>
              ))}
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
