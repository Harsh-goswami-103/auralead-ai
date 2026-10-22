/**
 * Plain words for the lead handoff (ADR-124, lead-gen F5), shared by the operator dialog and the
 * handoff card in both panels: status chips (icon + label, never color alone), the summary status
 * and what a handoff does. Pure data, server- and client-safe.
 */
import { CircleCheck, CircleSlash, Handshake, Loader2, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { StatusTone } from '@/components/patterns/status-vocabulary';
import { HANDOFF_SUMMARY_STATUS_LABELS, type HandoffSummaryStatus } from '@/lib/domain/lead-gen';
import { HANDOFF_STATUS_LABELS, type HandoffStatusValue } from '@/lib/schemas/handoff';

type ChipEntry = { label: string; tone: StatusTone; icon: LucideIcon; spinning?: boolean };

export const HANDOFF_STATUS_CHIPS: Readonly<Record<HandoffStatusValue, ChipEntry>> = {
  HANDED_OVER: { label: HANDOFF_STATUS_LABELS.HANDED_OVER, tone: 'info', icon: Handshake },
  ACKNOWLEDGED: { label: HANDOFF_STATUS_LABELS.ACKNOWLEDGED, tone: 'success', icon: CircleCheck },
};

export const SUMMARY_STATUS_CHIPS: Readonly<Record<HandoffSummaryStatus, ChipEntry>> = {
  READY: { label: HANDOFF_SUMMARY_STATUS_LABELS.READY, tone: 'success', icon: CircleCheck },
  PENDING: { label: HANDOFF_SUMMARY_STATUS_LABELS.PENDING, tone: 'info', icon: Loader2, spinning: true },
  NOT_CONFIGURED: { label: HANDOFF_SUMMARY_STATUS_LABELS.NOT_CONFIGURED, tone: 'neutral', icon: CircleSlash },
  FAILED: { label: HANDOFF_SUMMARY_STATUS_LABELS.FAILED, tone: 'warning', icon: TriangleAlert },
};

/** One sentence under the summary status when there is no summary to show. */
export const SUMMARY_STATUS_HELP: Readonly<Record<Exclude<HandoffSummaryStatus, 'READY'>, string>> = {
  PENDING: 'The summary is being written. This page updates by itself.',
  NOT_CONFIGURED: 'No AI integration is connected to this workspace, so no summary was written. The note and the conversation are all there is.',
  FAILED: 'The summary could not be written. Read the conversation instead.',
};

/** What "Hand over to client" does, in the order the server does it (ADR-124). */
export function handoffEffects(input: { salesStage: string; summaryAvailable: boolean }): string[] {
  return [
    input.salesStage === 'CONVERTED' ? 'The lead stays in Converted.' : 'The lead moves to Converted.',
    'AI replies stop: every open conversation of this lead is set to AI off and marked as handled by a person.',
    'Message drafts still waiting for approval are withdrawn.',
    'The automated pipeline stops for this lead.',
    input.summaryAvailable
      ? 'A short summary of the conversation is written for the client, next to your note.'
      : 'No AI integration is connected, so no summary is written: your note is what the client reads first.',
    'Afterwards you can still read the lead, but you can no longer message it or change its conversations. The client takes over.',
  ];
}
