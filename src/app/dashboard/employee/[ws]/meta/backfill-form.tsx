'use client';

/**
 * "Backfill from form since T" (T35; critic L-8): reads one mapped Instant Form's leads created
 * after the chosen time (last 90 days) from Meta and ingests them; leads that already arrived
 * count as duplicates. LIVE only (a mode gate in DEMO). One request key per submission, reused on
 * a retry. The run's result is listed below the form by the page.
 */
import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { History } from 'lucide-react';
import { toast } from 'sonner';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { newRequestKey } from './meta-vocabulary';

export function BackfillForm(props: { workspaceSlug: string; forms: string[]; defaultSince: string; gate: Gate | null }) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const formFieldId = useId();
  const sinceId = useId();
  const [formId, setFormId] = useState(props.forms[0] ?? '');
  const [since, setSince] = useState(props.defaultSince);
  const [requestKey, setRequestKey] = useState<string | null>(null);
  const [line, setLine] = useState<{ text: string; role: 'status' | 'alert' } | null>(null);
  const gate: Gate | null = props.gate ?? (props.forms.length === 0 ? { category: 'configuration', reason: 'Map an Instant Form first: a backfill reads one mapped form.' } : null);

  async function run() {
    setLine(null);
    const at = new Date(since);
    if (Number.isNaN(at.getTime())) {
      setLine({ text: 'Choose a start date and time.', role: 'alert' });
      return;
    }
    const key = requestKey ?? newRequestKey();
    setRequestKey(key);
    const res = await postJson<{ status: string; created: boolean }>('/api/app/meta/backfill', { workspaceSlug: props.workspaceSlug, formId, since: at.toISOString(), requestKey: key }, csrf);
    if (!res.ok) {
      setLine({ text: `${res.message}${res.reference ? ` Reference ${res.reference}.` : ''}`, role: 'alert' });
      return;
    }
    setRequestKey(null);
    setLine({ text: 'Backfill queued. Its result appears in the list below.', role: 'status' });
    toast.success('Backfill queued');
    router.refresh();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit} data-backfill-form>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={formFieldId}>Instant Form</Label>
          <NativeSelect id={formFieldId} value={formId} onChange={(e) => setFormId(e.target.value)}>
            {props.forms.length === 0 ? <option value="">No mapped form</option> : null}
            {props.forms.map((f) => (
              <option key={f} value={f}>
                Form {f}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={sinceId}>Leads created after</Label>
          <Input id={sinceId} type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} />
        </div>
      </div>
      <div className="flex flex-col items-start gap-1.5">
        <GatedAction label="Backfill from form" pendingLabel="Queueing..." variant="secondary" size="sm" icon={<History aria-hidden="true" />} gate={gate} onAction={run} />
        {line ? (
          <p role={line.role} className="max-w-prose text-xs text-fg-2">
            {line.text}
          </p>
        ) : null}
      </div>
    </form>
  );
}
