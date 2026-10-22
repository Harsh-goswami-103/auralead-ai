'use client';

/**
 * Mapping of one synced WhatsApp template (T32, P12): which send it is for (first message,
 * quotation ready, follow-up, call request reply), what each positional variable holds, and which
 * quick reply each button stands for (Send the quotation, Request a call, Stop messages). The
 * payload id of each mapped button is set on every send (ADR-62). The template itself is never
 * edited here: it is authored and approved in WhatsApp Manager. Posts to
 * /api/app/integrations/whatsapp/templates/[id]/mapping; the server checks the positions again.
 */
import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert, CircleCheck, Link2 } from 'lucide-react';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { QUICK_REPLY_INTENT_LABELS, QUICK_REPLY_INTENT_VALUES, TEMPLATE_INTENT_VALUES, TEMPLATE_VARIABLE_SOURCES } from '@/lib/domain/whatsapp-templates';
import { INTENT_LABELS } from './vocabulary';

export type TemplateMappingFormProps = {
  workspaceSlug: string;
  template: {
    id: string;
    name: string;
    intent: string | null;
    variables: string[];
    sources: Record<string, string>;
    quickReplies: Array<{ index: number; text: string; intent: string | null }>;
  };
};

export function TemplateMappingForm({ workspaceSlug, template }: TemplateMappingFormProps) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const id = useId();
  const [intent, setIntent] = useState(template.intent ?? '');
  const [sources, setSources] = useState<Record<string, string>>(() => ({ ...template.sources }));
  const [buttons, setButtons] = useState<Record<string, string>>(() => Object.fromEntries(template.quickReplies.filter((q) => q.intent).map((q) => [String(q.index), q.intent!])));
  const [line, setLine] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setLine(null);
    try {
      const res = await postJson(
        `/api/app/integrations/whatsapp/templates/${encodeURIComponent(template.id)}/mapping`,
        {
          workspaceSlug,
          intent: intent === '' ? null : intent,
          variables: Object.fromEntries(Object.entries(sources).filter(([, v]) => v !== '')),
          buttons: Object.fromEntries(Object.entries(buttons).filter(([, v]) => v !== '')),
        },
        csrf,
      );
      if (!res.ok) {
        setLine({ ok: false, text: `${res.message}${res.reference ? ` Reference ${res.reference}.` : ''}` });
        return;
      }
      setLine({ ok: true, text: 'Mapping saved.' });
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} aria-label={`Mapping of ${template.name}`} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-intent`} className="text-fg-1">
          Used for
        </Label>
        <NativeSelect id={`${id}-intent`} value={intent} onChange={(e) => setIntent(e.target.value)}>
          <option value="">Not mapped</option>
          {TEMPLATE_INTENT_VALUES.map((v) => (
            <option key={v} value={v}>
              {INTENT_LABELS[v] ?? v}
            </option>
          ))}
        </NativeSelect>
      </div>
      {template.variables.map((v) => (
        <div key={v} className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-var-${v}`} className="text-fg-1">
            <span className="font-mono">{`{{${v}}}`}</span> holds
          </Label>
          <NativeSelect id={`${id}-var-${v}`} value={sources[v] ?? ''} onChange={(e) => setSources((prev) => ({ ...prev, [v]: e.target.value }))}>
            <option value="">Not set</option>
            {Object.entries(TEMPLATE_VARIABLE_SOURCES).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </NativeSelect>
        </div>
      ))}
      {template.quickReplies.map((q) => (
        <div key={q.index} className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-btn-${q.index}`} className="text-fg-1">
            Button “{q.text}”
          </Label>
          <NativeSelect id={`${id}-btn-${q.index}`} value={buttons[String(q.index)] ?? ''} onChange={(e) => setButtons((prev) => ({ ...prev, [String(q.index)]: e.target.value }))}>
            <option value="">No action (sent without a payload)</option>
            {QUICK_REPLY_INTENT_VALUES.map((intentValue) => (
              <option key={intentValue} value={intentValue}>
                {QUICK_REPLY_INTENT_LABELS[intentValue]}
              </option>
            ))}
          </NativeSelect>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="secondary" size="sm" disabled={pending} aria-busy={pending || undefined}>
          <Link2 aria-hidden="true" />
          {pending ? 'Saving...' : 'Save mapping'}
        </Button>
        {line ? (
          <p role={line.ok ? 'status' : 'alert'} className="flex items-center gap-1.5 text-xs text-fg-1">
            {line.ok ? <CircleCheck aria-hidden="true" className="size-3.5 text-success" /> : <CircleAlert aria-hidden="true" className="size-3.5 text-danger" />}
            {line.text}
          </p>
        ) : null}
      </div>
    </form>
  );
}
