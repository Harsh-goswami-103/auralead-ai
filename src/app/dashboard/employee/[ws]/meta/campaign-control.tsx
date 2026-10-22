'use client';

/**
 * Pause or resume one campaign (T35; PRD "pause/resume with confirmation ... provider result";
 * AT14). The dialog states what happens, names the workspace and the campaign, and asks for the
 * typed word PAUSE or RESUME. One request key per dialog opening, reused on a retry, so a double
 * click is one action. The newest action is shown beside the control as icon plus label: Simulated
 * in DEMO; in LIVE "Queued", "Sending", "Unknown, confirming with Meta", "Confirmed by Meta" or
 * "Failed, nothing changed" with Meta's reason, never as success before Meta confirmed it. While an
 * action is in flight the page re-reads itself (bounded), then offers a manual refresh.
 */
import { useCallback, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pause, Play } from 'lucide-react';
import { toast } from 'sonner';
import { StatusChip } from '@/components/integrations/StatusChip';
import { useRefreshWhile } from '@/components/integrations/use-refresh-while';
import { postJson } from '@/components/patterns/api-client';
import { ConfirmDialog, type ConfirmOutcome } from '@/components/patterns/ConfirmDialog';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CAMPAIGN_CONFIRM_TEXT, type CampaignTargetStatus } from '@/lib/schemas/meta';
import { ACTION_STATE, failureLabel, newRequestKey, type ActionState } from './meta-vocabulary';

export type CampaignActionSummary = { state: ActionState; targetStatus: string; reasonCode: string | null; message: string | null; readBackStatus: string | null };

type ActionResponse = { state: ActionState; simulated: boolean; created: boolean };

const IN_FLIGHT: ReadonlySet<ActionState> = new Set(['PENDING', 'SENDING', 'UNKNOWN']);

export function CampaignControl(props: {
  workspaceSlug: string;
  workspaceName: string;
  campaignId: string;
  campaignName: string;
  configuredStatus: string;
  latest: CampaignActionSummary | null;
  gate: Gate | null;
}) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const [requestKey, setRequestKey] = useState<string | null>(null);
  const [runKey, setRunKey] = useState(0);
  const target: CampaignTargetStatus = props.configuredStatus.toUpperCase() === 'PAUSED' ? 'ACTIVE' : 'PAUSED';
  const word = CAMPAIGN_CONFIRM_TEXT[target];
  const verb = target === 'PAUSED' ? 'Pause' : 'Resume';
  const refresh = useCallback(() => router.refresh(), [router]);
  const inFlight = props.latest !== null && IN_FLIGHT.has(props.latest.state);
  const { exhausted } = useRefreshWhile(inFlight, refresh, runKey);

  async function confirm(): Promise<ConfirmOutcome> {
    if (typed.trim().toUpperCase() !== word) return { ok: false, message: `Type ${word} to confirm.` };
    const key = requestKey ?? newRequestKey();
    setRequestKey(key);
    const res = await postJson<ActionResponse>(`/api/app/campaigns/${encodeURIComponent(props.campaignId)}/status`, { workspaceSlug: props.workspaceSlug, targetStatus: target, confirm: word, requestKey: key }, csrf);
    if (!res.ok) return { ok: false, message: res.message, reference: res.reference };
    setRequestKey(null);
    setTyped('');
    setRunKey((k) => k + 1);
    toast.success(res.data.simulated ? `${verb}d (simulated)` : `${verb} queued`, {
      description: res.data.simulated ? 'Simulated: no provider contacted.' : 'The result appears here once Meta answers.',
    });
    router.refresh();
    return { ok: true };
  }

  const latest = props.latest;
  return (
    <div className="flex flex-col items-start gap-1.5" data-campaign-control={props.campaignId}>
      {props.gate || inFlight ? (
        <GatedAction
          label={verb}
          size="sm"
          variant="secondary"
          icon={target === 'PAUSED' ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          gate={props.gate ?? { category: 'eligibility', reason: 'A change to this campaign is still being confirmed with Meta.' }}
        />
      ) : (
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="secondary">
              {target === 'PAUSED' ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
              {verb}
            </Button>
          }
          title={`${verb} “${props.campaignName}”?`}
          description={
            target === 'PAUSED'
              ? 'Meta stops delivering this campaign’s ads. Spend stops once Meta applies the change.'
              : 'Meta resumes delivering this campaign’s ads, and spend resumes.'
          }
          confirmLabel={verb}
          pendingLabel="Sending..."
          workspaceName={props.workspaceName}
          destructive={target === 'PAUSED'}
          onConfirm={confirm}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={inputId}>Type {word} to confirm</Label>
            <Input id={inputId} value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
          </div>
        </ConfirmDialog>
      )}
      {latest ? (
        <div className="flex flex-col gap-0.5 text-xs text-fg-2">
          <StatusChip entry={ACTION_STATE[latest.state]} title={`Requested: ${latest.targetStatus}`} />
          {latest.reasonCode ? <span>{failureLabel(latest.reasonCode)}</span> : null}
          {latest.message ? <span className="max-w-xs wrap-anywhere">{latest.message}</span> : null}
          {exhausted ? (
            <button type="button" className="w-fit text-cyan underline-offset-4 hover:underline" onClick={refresh}>
              Refresh to see Meta’s answer
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
