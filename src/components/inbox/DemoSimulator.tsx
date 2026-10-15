'use client';

/**
 * DEMO only: the customer's side of WhatsApp (T22 UI over T20's `/api/webhooks/whatsapp/simulate`).
 * A lead "sends" a text, taps a quick reply (Get quote, Request a call, Stop) or sends START. The
 * payload runs through the same receive path as the verified webhook and is labelled Simulated; the
 * worker turns it into the inbound message, the AI suggestion and any call request. The page only
 * renders this in a DEMO process (the route does not exist in LIVE).
 */
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert, MessageSquarePlus } from 'lucide-react';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { ModeChip } from '@/components/patterns/StatusBadge';
import { useCsrfToken } from '@/components/patterns/csrf';
import { Label } from '@/components/ui/label';
import { postAction } from './api';

const EVENTS = [
  { value: 'text', label: 'Text message' },
  { value: 'quick_reply_quote', label: 'Taps "Get quote"' },
  { value: 'quick_reply_call', label: 'Taps "Request a call"' },
  { value: 'quick_reply_stop', label: 'Taps "Stop"' },
  { value: 'start', label: 'Sends START' },
] as const;

const fieldClass = 'h-9 w-full rounded-md border border-input bg-input/30 px-3 text-sm text-fg-1';

export function DemoSimulator(props: { leads: Array<{ id: string; displayName: string; phoneLast4: string }>; fixedLeadId?: string; canSimulate: boolean; compact?: boolean }) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const id = useId();
  const [leadId, setLeadId] = useState(props.fixedLeadId ?? props.leads[0]?.id ?? '');
  const [event, setEvent] = useState<(typeof EVENTS)[number]['value']>('text');
  const [text, setText] = useState('Hello, I would like to know more.');
  const [failure, setFailure] = useState<{ message: string; reference: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  let gate: Gate | null = null;
  if (!props.canSimulate) gate = { category: 'permission', reason: 'Simulating needs permission to write leads in this workspace.' };
  else if (leadId === '') gate = { category: 'eligibility', reason: 'No lead with a WhatsApp number yet. Simulate a lead source first (Sheets, Meta or Maps).' };

  async function simulate() {
    setFailure(null);
    setNotice(null);
    const res = await postAction('/api/webhooks/whatsapp/simulate', { leadId, event, ...(event === 'text' ? { text } : {}) }, csrf);
    if (!res.ok) {
      setFailure({ message: res.message, reference: res.reference });
      return;
    }
    setNotice('Simulated. The worker records it in a moment; this page refreshes on its own.');
    router.refresh();
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-3 rounded-xl border border-demo/30 bg-demo/5 p-4" data-demo-simulator>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`${id}-heading`} className="flex items-center gap-2 text-sm font-semibold text-fg-1">
          <MessageSquarePlus aria-hidden="true" className="size-4 text-demo" />
          Simulate a customer message
        </h2>
        <ModeChip simulated />
      </div>
      {!props.compact ? <p className="text-xs text-fg-2">Demo only. The message goes through the same WhatsApp receive path as a real one. Nothing leaves this app.</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {props.fixedLeadId ? null : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-lead`} className="text-fg-2">
              From lead
            </Label>
            <select id={`${id}-lead`} className={fieldClass} value={leadId} onChange={(e) => setLeadId(e.target.value)}>
              {props.leads.length === 0 ? <option value="">No leads with a WhatsApp number</option> : null}
              {props.leads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.displayName} (…{l.phoneLast4})
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-event`} className="text-fg-2">
            Customer action
          </Label>
          <select id={`${id}-event`} className={fieldClass} value={event} onChange={(e) => setEvent(e.target.value as typeof event)}>
            {EVENTS.map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
              </option>
            ))}
          </select>
        </div>
        {event === 'text' ? (
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor={`${id}-text`} className="text-fg-2">
              Customer text
            </Label>
            <input id={`${id}-text`} className={fieldClass} value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} />
          </div>
        ) : null}
      </div>
      <div>
        <GatedAction label="Simulate customer message" pendingLabel="Simulating..." variant="outline" gate={gate} onAction={simulate} />
      </div>
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
        <p role="status" className="text-sm text-success">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
