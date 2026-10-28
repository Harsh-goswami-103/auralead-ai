'use client';

/**
 * "Record opt-in" (ADR-117): the screen for POST /api/app/consent/grants (T18), so a lead that
 * arrived without consent (every Google Maps lead, ADR-15) can be messaged once the person really
 * opted in. The dialog asks for the channel (only those the lead has a contact for), the purpose
 * (WhatsApp only: eligibility counts any email opt-in for every email, so email is sent as MARKETING),
 * the evidence source, when the opt-in was given (the device's local time) and a note; a reference
 * and the wording agreed to are optional. The browser checks the evidence time and the note before
 * sending; the server decides everything else and its refusal is shown in the dialog. After a
 * success the page re-reads itself; a lifted or kept opt-out is said in plain words (O2, E3).
 *
 * Gated (plan §12) without leads.write (permission) or without any contact (eligibility). Nothing
 * here sends a message: sends still go through the approval queue and eligibility at dispatch.
 */
import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert, LoaderCircle, ShieldCheck, ShieldPlus } from 'lucide-react';
import { toast } from 'sonner';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction } from '@/components/patterns/GatedAction';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { CONSENT_NOTE_MAX, CONSENT_NOTE_MIN, MANUAL_CONSENT_SOURCES, type ManualConsentAnswer } from '@/lib/schemas/consent';
import type { ConsentChannelDto } from '@/lib/schemas/leads';

type Channel = ConsentChannelDto['channel'];
type Purpose = 'MARKETING' | 'SERVICE_CONVERSATION';
type Source = (typeof MANUAL_CONSENT_SOURCES)[number];

const CHANNEL_LABELS: Readonly<Record<Channel, string>> = { WHATSAPP: 'WhatsApp', EMAIL: 'email' };

const PURPOSES: ReadonlyArray<{ value: Purpose; label: string }> = [
  { value: 'MARKETING', label: 'Marketing messages, including the first message' },
  { value: 'SERVICE_CONVERSATION', label: 'Replies about their enquiry only' },
];

const SOURCES: Readonly<Record<Source, string>> = {
  MANUAL_EVIDENCE: 'Evidence I hold (signed form, message, call note)',
  SHEETS_FORM: 'A Google Sheets form the business ran',
  META_FORM: 'A Meta Lead Ads form',
};

type Failure = { message: string; reference: string | null };

export function RecordOptIn(props: {
  leadId: string;
  displayName: string;
  consent: readonly ConsentChannelDto[];
  phoneE164: string | null;
  emailNormalized: string | null;
  /** leads.write in this workspace (`permissions.canRecordConsent`). */
  canRecord: boolean;
  /** Operator console: the workspace the consent route acts in. */
  workspaceSlug?: string;
}) {
  const router = useRouter();
  const csrfToken = useCsrfToken();
  const id = useId();
  const channels = props.consent.filter((c) => c.state !== 'NO_CONTACT').map((c) => c.channel);
  const firstChannel = channels[0] ?? 'WHATSAPP';
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<Channel>(firstChannel);
  const [purpose, setPurpose] = useState<Purpose>('MARKETING');
  const [source, setSource] = useState<Source>('MANUAL_EVIDENCE');
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);

  if (!props.canRecord) {
    return <GatedAction label="Record opt-in" size="sm" gate={{ category: 'permission', reason: 'Recording an opt-in needs leads.write, which you do not hold in this workspace.' }} />;
  }
  if (channels.length === 0) {
    return <GatedAction label="Record opt-in" size="sm" gate={{ category: 'eligibility', reason: 'This lead has no phone number or email address to record an opt-in for.' }} />;
  }

  function reset() {
    setChannel(firstChannel);
    setPurpose('MARKETING');
    setSource('MANUAL_EVIDENCE');
    setWhen('');
    setNote('');
    setReference('');
    setNotice('');
    setFailure(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFailure(null);
    const at = new Date(when);
    if (when === '' || Number.isNaN(at.getTime())) {
      setFailure({ message: 'Choose when they opted in.', reference: null });
      return;
    }
    if (at.getTime() > Date.now()) {
      setFailure({ message: 'The opt-in time cannot be in the future.', reference: null });
      return;
    }
    const trimmedNote = note.trim();
    if (trimmedNote.length < CONSENT_NOTE_MIN) {
      setFailure({ message: `Describe the evidence in at least ${CONSENT_NOTE_MIN} characters.`, reference: null });
      return;
    }
    const trimmedReference = reference.trim();
    const trimmedNotice = notice.trim();
    setPending(true);
    try {
      const res = await postJson<ManualConsentAnswer>(
        '/api/app/consent/grants',
        {
          ...(props.workspaceSlug ? { workspaceSlug: props.workspaceSlug } : {}),
          leadId: props.leadId,
          channel,
          purpose: channel === 'EMAIL' ? 'MARKETING' : purpose,
          source,
          collectedAt: at.toISOString(),
          evidence: { note: trimmedNote, ...(trimmedReference ? { reference: trimmedReference } : {}) },
          ...(trimmedNotice ? { noticeText: trimmedNotice } : {}),
        },
        csrfToken,
      );
      if (!res.ok) {
        setFailure({ message: res.message, reference: res.reference });
        return;
      }
      const label = CHANNEL_LABELS[channel];
      if (res.data.reoptIn === 'EVIDENCE_NOT_NEWER') {
        toast.warning('Opt-in recorded, but the opt-out stays.', { description: `This evidence is older than their latest Stop, so messages on ${label} stay blocked.` });
      } else {
        toast.success(`Opt-in recorded for ${label}.`, res.data.reoptIn === 'CLEARED' ? { description: 'Their earlier opt-out is lifted: this opt-in is newer than their last Stop.' } : undefined);
      }
      reset();
      setOpen(false);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  const contactOf = (c: Channel) => (c === 'WHATSAPP' ? props.phoneE164 : props.emailNormalized);
  const errorId = `${id}-error`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else if (!pending) {
          reset();
          setOpen(false);
        }
      }}
    >
      {/* DialogTrigger, so focus returns here when the dialog closes. */}
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="gap-1.5 self-start">
          <ShieldPlus aria-hidden="true" />
          Record opt-in
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form noValidate onSubmit={(e) => void submit(e)} aria-describedby={failure ? errorId : undefined} className="flex flex-col gap-4">
          {/* pr-8 clears the close button: the content only pads a header that is its direct child. */}
          <DialogHeader className="pr-8">
            <DialogTitle>Record an opt-in for {props.displayName}</DialogTitle>
            <DialogDescription>
              Record only consent this person actually gave, and keep the evidence. A Google Maps listing or a public phone number is not an opt-in.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-channel`}>Channel</Label>
              <NativeSelect id={`${id}-channel`} value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
                {channels.map((c) => (
                  <option key={c} value={c}>
                    {`${c === 'WHATSAPP' ? 'WhatsApp' : 'Email'} · ${contactOf(c) ?? ''}`}
                  </option>
                ))}
              </NativeSelect>
            </div>
            {channel === 'WHATSAPP' ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-purpose`}>Purpose</Label>
                <NativeSelect id={`${id}-purpose`} value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)} aria-describedby={`${id}-purpose-hint`}>
                  {PURPOSES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </NativeSelect>
                <p id={`${id}-purpose-hint`} className="text-xs text-fg-2">
                  A first WhatsApp message (a template) needs a marketing opt-in.
                </p>
              </div>
            ) : (
              <p className="self-end text-xs text-fg-2 sm:pb-2">An email opt-in covers every email from this business, marketing included.</p>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-source`}>Evidence</Label>
              <NativeSelect id={`${id}-source`} value={source} onChange={(e) => setSource(e.target.value as Source)}>
                {MANUAL_CONSENT_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {SOURCES[s]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-when`}>When they opted in (your device&apos;s time)</Label>
              <Input id={`${id}-when`} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-note`}>What the evidence is</Label>
            <Textarea
              id={`${id}-note`}
              value={note}
              maxLength={CONSENT_NOTE_MAX}
              onChange={(e) => setNote(e.target.value)}
              placeholder="For example: signed the enquiry form at the front desk; the paper form is filed"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-reference`}>Reference (optional)</Label>
              <Input id={`${id}-reference`} value={reference} maxLength={200} autoComplete="off" onChange={(e) => setReference(e.target.value)} placeholder="Form number, message link" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-notice`}>Wording they agreed to (optional)</Label>
              <Input id={`${id}-notice`} value={notice} maxLength={2000} autoComplete="off" onChange={(e) => setNotice(e.target.value)} placeholder="Only its fingerprint is stored" />
            </div>
          </div>
          {failure ? (
            <p id={errorId} role="alert" className="flex items-start gap-2 rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-fg-1">
              <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
              <span>
                {failure.message}
                {failure.reference ? <span className="block text-xs text-fg-2">Reference: {failure.reference}</span> : null}
              </span>
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                reset();
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" aria-busy={pending || undefined}>
              {pending ? <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" /> : <ShieldCheck aria-hidden="true" />}
              {pending ? 'Recording...' : 'Record opt-in'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
