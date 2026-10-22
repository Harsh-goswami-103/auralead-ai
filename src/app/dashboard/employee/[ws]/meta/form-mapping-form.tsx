'use client';

/**
 * Map an Instant Form (T35; P1): the form id, the question key for each lead field (Meta's standard
 * keys prefilled), and optionally the consent question (or custom disclaimer checkbox key) with
 * the answers that mean yes, the channel and purpose, and the notice text the person agreed to
 * (its hash is stored as consent evidence). Saving replaces the form's mapping. A form id can be
 * prefilled from "forms that sent leads without a mapping".
 */
import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Save } from 'lucide-react';
import { toast } from 'sonner';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { META_ID_RE, META_STANDARD_FIELD_MAP } from '@/lib/schemas/meta';

const FIELDS = [
  { key: 'name', label: 'Name question key' },
  { key: 'phone', label: 'Phone question key' },
  { key: 'email', label: 'Email question key' },
  { key: 'city', label: 'City question key' },
] as const;

export function FormMappingForm(props: { workspaceSlug: string; gate: Gate | null; defaultFormId?: string }) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const base = useId();
  const [formId, setFormId] = useState(props.defaultFormId ?? '');
  const [fields, setFields] = useState<Record<string, string>>({ ...META_STANDARD_FIELD_MAP });
  const [withConsent, setWithConsent] = useState(true);
  const [question, setQuestion] = useState('');
  const [truthy, setTruthy] = useState('yes');
  const [channel, setChannel] = useState<'WHATSAPP' | 'EMAIL'>('WHATSAPP');
  const [notice, setNotice] = useState('');
  const [line, setLine] = useState<{ text: string; role: 'status' | 'alert' } | null>(null);

  async function save() {
    setLine(null);
    if (!META_ID_RE.test(formId.trim())) {
      setLine({ text: 'The form ID is the number Meta shows for the Instant Form (5 to 32 digits).', role: 'alert' });
      return;
    }
    const truthyValues = truthy
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    if (withConsent && (question.trim() === '' || truthyValues.length === 0 || notice.trim().length < 10)) {
      setLine({ text: 'For the consent question, enter its key, the answers that mean yes, and the notice text shown on the form.', role: 'alert' });
      return;
    }
    const body = {
      workspaceSlug: props.workspaceSlug,
      formId: formId.trim(),
      fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, v.trim()])),
      consent: withConsent ? { question: question.trim(), truthyValues, channel, purpose: 'MARKETING', noticeText: notice.trim() } : null,
    };
    const res = await postJson<{ created: boolean }>('/api/app/meta/forms', body, csrf);
    if (!res.ok) {
      setLine({ text: `${res.message}${res.reference ? ` Reference ${res.reference}.` : ''}`, role: 'alert' });
      return;
    }
    const text = `${res.data.created ? 'Mapping saved' : 'Mapping replaced'} for form ${body.formId}.`;
    setLine({ text, role: 'status' });
    toast.success(text);
    router.refresh();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit} data-form-mapping-form>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${base}-form`}>Instant Form ID</Label>
        <Input id={`${base}-form`} inputMode="numeric" value={formId} onChange={(e) => setFormId(e.target.value)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <div key={f.key} className="flex flex-col gap-1.5">
            <Label htmlFor={`${base}-${f.key}`}>{f.label}</Label>
            <Input id={`${base}-${f.key}`} value={fields[f.key] ?? ''} onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.value }))} />
          </div>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm text-fg-1">
        <input type="checkbox" checked={withConsent} onChange={(e) => setWithConsent(e.target.checked)} className="size-4 accent-cyan" />
        The form asks for consent
      </label>
      {withConsent ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${base}-question`}>Consent question or checkbox key</Label>
            <Input id={`${base}-question`} value={question} onChange={(e) => setQuestion(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${base}-truthy`}>Answers that mean yes (comma separated)</Label>
            <Input id={`${base}-truthy`} value={truthy} onChange={(e) => setTruthy(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${base}-channel`}>Channel</Label>
            <NativeSelect id={`${base}-channel`} value={channel} onChange={(e) => setChannel(e.target.value === 'EMAIL' ? 'EMAIL' : 'WHATSAPP')}>
              <option value="WHATSAPP">WhatsApp</option>
              <option value="EMAIL">Email</option>
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor={`${base}-notice`}>Notice text shown on the form</Label>
            <Textarea id={`${base}-notice`} rows={3} value={notice} onChange={(e) => setNotice(e.target.value)} />
          </div>
        </div>
      ) : null}
      <div className="flex flex-col items-start gap-1.5">
        <GatedAction label="Save mapping" pendingLabel="Saving..." variant="secondary" size="sm" icon={<Save aria-hidden="true" />} gate={props.gate} onAction={save} />
        {line ? (
          <p role={line.role} className="max-w-prose text-xs text-fg-2">
            {line.text}
          </p>
        ) : null}
      </div>
    </form>
  );
}
