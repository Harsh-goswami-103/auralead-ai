'use client';

/**
 * DEMO only: "Customer's phone (Simulated)", the customer's side of one WhatsApp thread in a phone
 * frame beside the conversation (ADR-121; T22 UI over T20's `/api/webhooks/whatsapp/simulate`).
 *
 * The screen mirrors what the customer would see: the business's messages that were sent (drafts
 * and messages that never left are not on their phone) on the left, their own on the right, with
 * the business's name in the top bar. At the bottom the presenter types as the customer or taps a
 * quick reply (Get quote, Request a call, Stop, START). Each one runs through the same receive path
 * as the verified webhook and is labelled Simulated; the worker turns it into the inbound message
 * and any reply, and the page re-reads itself. The page renders this only in a DEMO process (the
 * route does not exist in LIVE). `workspaceSlug` names the operator's assigned workspace.
 */
import { useId, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert, CircleCheck, SendHorizontal, Smartphone } from 'lucide-react';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { ModeChip } from '@/components/patterns/StatusBadge';
import { useCsrfToken } from '@/components/patterns/csrf';
import { Label } from '@/components/ui/label';
import { cn } from '@/components/ui/cn';
import { postAction } from './api';

export type PhoneMessage = { id: string; from: 'customer' | 'business'; text: string; time: string };

const QUICK = [
  { event: 'quick_reply_quote', label: 'Get quote' },
  { event: 'quick_reply_call', label: 'Request a call' },
  { event: 'quick_reply_stop', label: 'Stop' },
  { event: 'start', label: 'START' },
] as const;

export const CUSTOMER_PHONE_TITLE = "Customer's phone";

export function CustomerPhone(props: { leadId: string; leadName: string; businessName: string; messages: PhoneMessage[]; canSimulate: boolean; workspaceSlug?: string }) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const id = useId();
  const [text, setText] = useState('');
  const [failure, setFailure] = useState<{ message: string; reference: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busy = useRef(false);

  const gate: Gate | null = props.canSimulate ? null : { category: 'permission', reason: 'Simulating needs permission to write leads in this workspace.' };

  async function simulate(event: 'text' | (typeof QUICK)[number]['event']) {
    if (busy.current) return;
    setFailure(null);
    setNotice(null);
    if (event === 'text' && text.trim() === '') {
      setFailure({ message: 'Type the customer’s message first.', reference: null });
      return;
    }
    busy.current = true;
    const res = await postAction(
      '/api/webhooks/whatsapp/simulate',
      { leadId: props.leadId, event, ...(event === 'text' ? { text } : {}), ...(props.workspaceSlug ? { workspaceSlug: props.workspaceSlug } : {}) },
      csrf,
    ).finally(() => {
      busy.current = false;
    });
    if (!res.ok) {
      setFailure({ message: res.message, reference: res.reference });
      return;
    }
    if (event === 'text') setText('');
    setNotice('Simulated. The worker records it in a moment; this page refreshes on its own.');
    router.refresh();
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="flex min-w-0 flex-col gap-3" data-customer-phone>
      <h2 id={`${id}-heading`} className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg-1">
        <Smartphone aria-hidden="true" className="size-4 text-fg-2" />
        {CUSTOMER_PHONE_TITLE} <ModeChip simulated />
      </h2>
      <div className="mx-auto flex w-full max-w-[20rem] flex-col overflow-hidden rounded-[2rem] border-[6px] border-bg-3 bg-chat-wallpaper">
        <div className="flex items-center gap-2 bg-bg-2 px-4 pt-3 pb-2">
          <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-chat-accent text-xs font-semibold text-cyan-fg">
            {props.businessName.trim().charAt(0).toUpperCase() || '?'}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-fg-1">{props.businessName}</span>
            <span className="block truncate text-[11px] text-chat-meta">as seen by {props.leadName}</span>
          </span>
        </div>
        <ol aria-label="Messages on the customer's phone" className="flex max-h-80 min-h-48 flex-col gap-1.5 overflow-y-auto overscroll-contain px-3 py-3">
          {props.messages.length === 0 ? <li className="m-auto text-center text-xs text-fg-2">No messages yet.</li> : null}
          {props.messages.map((m) => (
            <li key={m.id} className={cn('flex', m.from === 'customer' ? 'justify-end' : 'justify-start')}>
              <span
                className={cn(
                  'flex max-w-[85%] flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-xs break-words whitespace-pre-line text-fg-1',
                  m.from === 'customer' ? 'rounded-tr-none bg-chat-bubble-out' : 'rounded-tl-none bg-chat-bubble-in',
                )}
              >
                {m.text}
                <span className="self-end text-[10px] text-chat-meta">{m.time}</span>
              </span>
            </li>
          ))}
        </ol>
        <div className="flex flex-col gap-2 bg-bg-2 px-3 pt-2 pb-3">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick replies">
            {QUICK.map((q) => (
              <GatedAction key={q.event} label={q.label} size="xs" variant="outline" gate={gate} onAction={() => simulate(q.event)} className="rounded-full" />
            ))}
          </div>
          <form
            className="flex items-center gap-2"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (!gate) void simulate('text');
            }}
          >
            <Label htmlFor={`${id}-text`} className="sr-only">
              Customer text
            </Label>
            <input
              id={`${id}-text`}
              value={text}
              maxLength={1000}
              placeholder="Message"
              onChange={(e) => setText(e.target.value)}
              // 16 px below md so iOS does not zoom on focus (the shared fieldSurface rule); 44 px below lg; the global focus outline stays.
              className="min-h-11 min-w-0 flex-1 rounded-full border border-border-input bg-bg-1 px-3 text-md text-fg-1 placeholder:text-fg-3 focus-visible:border-chat-accent md:text-sm lg:min-h-10"
            />
            {gate ? (
              <GatedAction label="Simulate customer message" size="sm" variant="outline" gate={gate} />
            ) : (
              <button
                type="submit"
                aria-label="Simulate customer message"
                className="inline-flex size-11 shrink-0 lg:size-10 items-center justify-center rounded-full bg-chat-accent text-cyan-fg transition-opacity duration-fast hover:opacity-90"
              >
                <SendHorizontal aria-hidden="true" className="size-4" />
              </button>
            )}
          </form>
        </div>
      </div>
      <p className="text-xs text-fg-2">Demo only: these messages go through the same WhatsApp receive path as a real one. Nothing leaves this app.</p>
      {failure ? (
        <p role="alert" className="flex items-start gap-2 text-sm text-fg-1">
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
    </section>
  );
}
