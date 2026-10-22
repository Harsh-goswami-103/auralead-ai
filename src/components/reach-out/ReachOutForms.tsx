'use client';

/**
 * The reach-out panel's controls (ADR-125, lead-gen F5). Each posts to a /api/app/* route with the
 * session CSRF token and shows the server's answer; nothing is decided in the browser.
 *  - RecordOptInForm: "Record WhatsApp opt-in" for a lead without one. The notice is prefilled from
 *    the workspace setting (it must name the business), the person picks how the customer agreed
 *    (`evidence.method`), when, and a short note. POST /api/app/consent/grants (WHATSAPP, MARKETING,
 *    MANUAL_EVIDENCE). The answer says whether an earlier STOP was cleared or kept.
 *  - ClickToChatLink: the wa.me link to the business's WhatsApp number with a prefilled first
 *    message, and Copy. Changing the text asks the server for the link again, which refuses a
 *    START or STOP keyword.
 *  - ReachOutSettingsForm: the workspace's own opt-in notice and privacy contact.
 */
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert, Link2, Save, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { CopyButton } from '@/components/admin/CopyButton';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { ModeChip } from '@/components/patterns/StatusBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { OPT_IN_METHOD_LABELS, OPT_IN_METHODS, type OptInMethod } from '@/lib/schemas/consent';
import { CLICK_TO_CHAT_PREFILL_MAX, OPT_IN_NOTICE_MAX, PRIVACY_CONTACT_MAX, type ClickToChatResultDto } from '@/lib/schemas/reach-out';

type Failure = { message: string; reference: string | null } | null;

function FailureLine({ failure }: { failure: Failure }) {
  if (!failure) return null;
  return (
    <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/35 bg-danger/12 px-3 py-2 text-sm text-fg-1">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
      <span>
        {failure.message}
        {failure.reference ? <span className="block text-xs text-fg-2">Reference: {failure.reference}</span> : null}
      </span>
    </p>
  );
}

function Field(props: { label: string; hint?: ReactNode; children: (ids: { id: string; hintId: string | undefined }) => ReactNode }) {
  const id = useId();
  const hintId = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className="text-fg-1">
        {props.label}
      </Label>
      {props.children({ id, hintId: props.hint ? hintId : undefined })}
      {props.hint ? (
        <span id={hintId} className="text-xs text-fg-2">
          {props.hint}
        </span>
      ) : null}
    </div>
  );
}

/** `YYYY-MM-DDTHH:mm` of this moment in the browser's time zone (the datetime-local value). */
function localNow(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

const REOPT_IN_TEXT: Readonly<Record<string, string>> = {
  CLEARED: 'An earlier STOP was cleared, because this opt-in is newer.',
  EVIDENCE_NOT_NEWER: 'An earlier STOP stays in force: this opt-in is not newer than it.',
};

export const RECORD_OPT_IN_LABEL = 'Record WhatsApp opt-in';

export function RecordOptInForm(props: { leadId: string; workspaceSlug: string; businessName: string; noticePrefill: string; gate: Gate | null }) {
  const router = useRouter();
  const csrfToken = useCsrfToken();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState(props.noticePrefill);
  const [method, setMethod] = useState<OptInMethod | ''>('');
  const [collectedAt, setCollectedAt] = useState('');
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure>(null);

  if (props.gate) return <GatedAction label={RECORD_OPT_IN_LABEL} icon={<ShieldCheck aria-hidden="true" />} gate={props.gate} />;

  if (!open) {
    return (
      <Button
        type="button"
        variant="secondary"
        aria-expanded={false}
        onClick={() => {
          setCollectedAt(localNow());
          setOpen(true);
        }}
      >
        <ShieldCheck aria-hidden="true" />
        {RECORD_OPT_IN_LABEL}
      </Button>
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFailure(null);
    const when = new Date(collectedAt);
    if (Number.isNaN(when.getTime())) {
      setFailure({ message: 'Enter when the customer agreed.', reference: null });
      return;
    }
    setPending(true);
    try {
      const res = await postJson<{ consentId: string; reoptIn: string }>(
        '/api/app/consent/grants',
        {
          workspaceSlug: props.workspaceSlug,
          leadId: props.leadId,
          channel: 'WHATSAPP',
          purpose: 'MARKETING',
          source: 'MANUAL_EVIDENCE',
          collectedAt: when.toISOString(),
          evidence: { note: note.trim(), ...(method ? { method } : {}), ...(reference.trim() ? { reference: reference.trim() } : {}) },
          ...(notice.trim() ? { noticeText: notice.trim() } : {}),
        },
        csrfToken,
      );
      if (!res.ok) {
        setFailure({ message: res.message, reference: res.reference });
        return;
      }
      toast.success(['WhatsApp opt-in recorded.', REOPT_IN_TEXT[res.data.reoptIn]].filter(Boolean).join(' '));
      setOpen(false);
      setNote('');
      setReference('');
      setMethod('');
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <form aria-label={RECORD_OPT_IN_LABEL} onSubmit={(e) => void submit(e)} className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-bg-2/40 p-3.5">
      <Field label="Notice the customer agreed to" hint={`It must name ${props.businessName}. It is kept with the opt-in as evidence.`}>
        {({ id, hintId }) => (
          <Textarea id={id} name="noticeText" required rows={4} maxLength={OPT_IN_NOTICE_MAX} aria-describedby={hintId} value={notice} onChange={(e) => setNotice(e.target.value)} />
        )}
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="How the customer agreed">
          {({ id }) => (
            <NativeSelect id={id} name="method" required value={method} onChange={(e) => setMethod(e.target.value as OptInMethod | '')}>
              <option value="">Choose how</option>
              {OPT_IN_METHODS.map((m) => (
                <option key={m} value={m}>
                  {OPT_IN_METHOD_LABELS[m]}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="When they agreed">{({ id }) => <Input id={id} name="collectedAt" type="datetime-local" required value={collectedAt} onChange={(e) => setCollectedAt(e.target.value)} />}</Field>
      </div>
      <Field label="What happened" hint="At least 5 characters, for example who spoke to them and where.">
        {({ id, hintId }) => <Input id={id} name="note" required minLength={5} maxLength={500} aria-describedby={hintId} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
      <Field label="Reference (optional)" hint="A form number, call log entry or file name.">
        {({ id, hintId }) => <Input id={id} name="reference" maxLength={200} aria-describedby={hintId} value={reference} onChange={(e) => setReference(e.target.value)} />}
      </Field>
      <FailureLine failure={failure} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" aria-busy={pending || undefined}>
          <ShieldCheck aria-hidden="true" />
          {pending ? 'Recording...' : 'Record opt-in'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function ClickToChatLink(props: { workspaceSlug: string; link: string; prefill: string; displayPhoneNumber: string; simulated: boolean }) {
  const csrfToken = useCsrfToken();
  const prefillId = useId();
  const linkId = useId();
  const [link, setLink] = useState(props.link);
  const [prefill, setPrefill] = useState(props.prefill);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure>(null);

  async function rebuild(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFailure(null);
    setPending(true);
    try {
      const res = await postJson<ClickToChatResultDto>('/api/app/settings/reach-out/click-to-chat', { workspaceSlug: props.workspaceSlug, prefill: prefill.trim() }, csrfToken);
      if (!res.ok) {
        setFailure({ message: res.message, reference: res.reference });
        return;
      }
      setLink(res.data.link);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor={linkId} className="flex flex-wrap items-center gap-2 text-fg-1">
          Click-to-chat link to {props.displayPhoneNumber}
          {props.simulated ? <ModeChip simulated /> : null}
        </Label>
        <span className="flex min-w-0 items-center gap-1">
          <Input id={linkId} readOnly value={link} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <CopyButton value={link} label="click-to-chat link" showText />
        </span>
      </div>
      <form aria-label="First message" onSubmit={(e) => void rebuild(e)} className="flex flex-col gap-1.5">
        <Label htmlFor={prefillId} className="text-fg-1">
          First message the customer sends
        </Label>
        <span className="flex min-w-0 flex-wrap items-center gap-2 sm:flex-nowrap">
          <Input id={prefillId} name="prefill" required maxLength={CLICK_TO_CHAT_PREFILL_MAX} value={prefill} onChange={(e) => setPrefill(e.target.value)} />
          <Button type="submit" variant="outline" aria-busy={pending || undefined}>
            <Link2 aria-hidden="true" />
            {pending ? 'Updating...' : 'Update link'}
          </Button>
        </span>
      </form>
      <FailureLine failure={failure} />
    </div>
  );
}

export function ReachOutSettingsForm(props: { workspaceSlug: string; businessName: string; notice: string | null; privacyContact: string | null }) {
  const router = useRouter();
  const csrfToken = useCsrfToken();
  const [notice, setNotice] = useState(props.notice ?? '');
  const [contact, setContact] = useState(props.privacyContact ?? '');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFailure(null);
    setPending(true);
    try {
      const res = await postJson<{ changed: string[] }>(
        '/api/app/settings/reach-out',
        { workspaceSlug: props.workspaceSlug, whatsappOptInNotice: notice.trim() === '' ? null : notice.trim(), privacyContact: contact.trim() === '' ? null : contact.trim() },
        csrfToken,
      );
      if (!res.ok) {
        setFailure({ message: res.message, reference: res.reference });
        return;
      }
      toast.success(res.data.changed.length === 0 ? 'Nothing changed.' : 'Opt-in notice and privacy contact saved.');
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <form aria-label="Workspace opt-in notice" onSubmit={(e) => void save(e)} className="flex flex-col gap-3">
      <Field label="WhatsApp opt-in notice" hint={`Prefilled whenever someone records an opt-in. It must name ${props.businessName}. Leave it empty to use the default notice.`}>
        {({ id, hintId }) => <Textarea id={id} name="whatsappOptInNotice" rows={4} maxLength={OPT_IN_NOTICE_MAX} aria-describedby={hintId} value={notice} onChange={(e) => setNotice(e.target.value)} />}
      </Field>
      <Field label="Privacy contact" hint="Who customers can ask about their data: an email address or phone number.">
        {({ id, hintId }) => <Input id={id} name="privacyContact" maxLength={PRIVACY_CONTACT_MAX} aria-describedby={hintId} value={contact} onChange={(e) => setContact(e.target.value)} />}
      </Field>
      <FailureLine failure={failure} />
      <Button type="submit" variant="outline" className="self-start" aria-busy={pending || undefined}>
        <Save aria-hidden="true" />
        {pending ? 'Saving...' : 'Save notice'}
      </Button>
    </form>
  );
}
