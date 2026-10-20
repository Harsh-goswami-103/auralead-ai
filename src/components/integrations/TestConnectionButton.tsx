'use client';

/**
 * "Test connection" (T28; PRD truthfulness: never a simulated success in LIVE). Posts to
 * /api/app/integrations/[kind]/test with the workspace slug and shows the server's answer in
 * words next to the button: "Simulated, no provider contacted" in DEMO (status unchanged),
 * "Verification required" when no live check exists yet, or the live result. A refusal shows the
 * server's message and reference. Gated on permission or configuration only (plan §12).
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert, CircleCheck, FlaskConical, PlugZap, ShieldAlert } from 'lucide-react';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { INTEGRATION_STATUS_VOCABULARY } from '@/components/patterns/status-vocabulary';
import { cn } from '@/components/ui/cn';
import type { IntegrationStatus } from '@/lib/domain/enums';

type TestResponse = { outcome: 'SIMULATED' | 'VERIFICATION_REQUIRED' | 'TESTED'; status: IntegrationStatus; message: string; errorCode: string | null };

type Shown = { tone: 'demo' | 'warning' | 'success' | 'danger'; text: string; detail: string | null; role: 'status' | 'alert' };

const TONE_TEXT: Readonly<Record<Shown['tone'], string>> = { demo: 'text-demo', warning: 'text-warning', success: 'text-success', danger: 'text-danger' };
const TONE_ICON = { demo: FlaskConical, warning: ShieldAlert, success: CircleCheck, danger: CircleAlert } as const;

function shownFor(data: TestResponse): Shown {
  const statusLabel = INTEGRATION_STATUS_VOCABULARY[data.status].label;
  if (data.outcome === 'SIMULATED') return { tone: 'demo', text: data.message, detail: `Status unchanged: ${statusLabel}.`, role: 'status' };
  if (data.outcome === 'VERIFICATION_REQUIRED') return { tone: 'warning', text: data.message, detail: null, role: 'status' };
  return { tone: data.status === 'CONNECTED' ? 'success' : 'danger', text: data.message, detail: `Status now: ${statusLabel}.`, role: 'status' };
}

export function TestConnectionButton(props: { workspaceSlug: string; kindSlug: string; label: string; gate: Gate | null; size?: 'sm' | 'default' }) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const [shown, setShown] = useState<Shown | null>(null);

  async function run() {
    setShown(null);
    const res = await postJson<TestResponse>(`/api/app/integrations/${props.kindSlug}/test`, { workspaceSlug: props.workspaceSlug }, csrf);
    if (!res.ok) {
      setShown({ tone: 'danger', text: res.message, detail: res.reference ? `Reference ${res.reference}` : null, role: 'alert' });
      return;
    }
    setShown(shownFor(res.data));
    router.refresh();
  }

  const Icon = shown ? TONE_ICON[shown.tone] : null;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <GatedAction
        label="Test connection"
        pendingLabel="Testing..."
        variant="secondary"
        size={props.size === 'default' ? 'default' : 'sm'}
        icon={<PlugZap aria-hidden="true" />}
        gate={props.gate}
        onAction={run}
      />
      {shown && Icon ? (
        <p role={shown.role} data-test-result={shown.tone} className="flex max-w-prose items-start gap-1.5 text-xs text-fg-1">
          <Icon aria-hidden="true" className={cn('mt-px size-3.5 shrink-0', TONE_TEXT[shown.tone])} />
          <span>
            <span className="font-medium">{shown.text}</span>
            {shown.detail ? <span className="text-fg-2"> {shown.detail}</span> : null}
          </span>
        </p>
      ) : null}
    </div>
  );
}
