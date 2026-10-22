/**
 * Operator panel vocabulary for leads (design spec §6; employee report "these copies will drift"):
 * one label, tone and icon per sales stage, pipeline stage and stage-run status, the plain-language
 * text for every reason code the pipeline stages store, and the review-reason sentences shared by
 * the lead detail and the approval item. Nothing here invents a state: every key is a value the
 * services emit, and an unknown code still reads as a sentence, never as a raw enum.
 */
import {
  BadgeCheck,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  CircleX,
  ClipboardCheck,
  Clock,
  FileText,
  Gauge,
  Inbox,
  Loader2,
  MessagesSquare,
  PenLine,
  Send,
  type LucideIcon,
} from 'lucide-react';
import type { StatusTone } from '@/components/patterns/status-vocabulary';
import { formatINR } from '@/lib/money';

export type VocabularyEntry = { label: string; tone: StatusTone; icon: LucideIcon; spinning?: boolean };

/** Lead sales stage (SalesStage). Status chips: tone + icon + label, never color alone. */
export const SALES_STAGE_VOCABULARY: Readonly<Record<string, VocabularyEntry>> = {
  NEW: { label: 'New', tone: 'info', icon: CircleDot },
  CONTACTED: { label: 'Contacted', tone: 'info', icon: Send },
  REPLIED: { label: 'Replied', tone: 'success', icon: MessagesSquare },
  QUOTE_SENT: { label: 'Quote sent', tone: 'info', icon: FileText },
  CONVERTED: { label: 'Converted', tone: 'success', icon: BadgeCheck },
  LOST: { label: 'Lost', tone: 'neutral', icon: CircleSlash },
};

export function salesStageEntry(stage: string): VocabularyEntry {
  return SALES_STAGE_VOCABULARY[stage] ?? { label: humanize(stage), tone: 'neutral', icon: CircleDot };
}

/** Pipeline stages in their pinned order, with the step icon of the stepper rail. */
export const PIPELINE_STAGE_VOCABULARY: Readonly<Record<string, { label: string; icon: LucideIcon }>> = {
  INGESTION: { label: 'Ingestion', icon: Inbox },
  SCORE: { label: 'Website check and score', icon: Gauge },
  DRAFT: { label: 'Draft', icon: PenLine },
  APPROVAL: { label: 'Approval', icon: ClipboardCheck },
  DELIVERY: { label: 'Delivery', icon: Send },
};

/** PipelineStageRun status. */
export const RUN_STATUS_VOCABULARY: Readonly<Record<string, VocabularyEntry>> = {
  PENDING: { label: 'Waiting', tone: 'warning', icon: Clock },
  RUNNING: { label: 'Running', tone: 'info', icon: Loader2, spinning: true },
  DONE: { label: 'Done', tone: 'success', icon: CircleCheck },
  SKIPPED: { label: 'Skipped', tone: 'neutral', icon: CircleDashed },
  FAILED: { label: 'Failed', tone: 'danger', icon: CircleX },
};

export function runStatusEntry(status: string): VocabularyEntry {
  return RUN_STATUS_VOCABULARY[status] ?? { label: humanize(status), tone: 'neutral', icon: CircleDashed };
}

/**
 * Every reasonCode a stage run can carry (pipeline executor and src/server/services/pipeline/stages):
 * waiting, skipped and failed outcomes in plain words.
 */
export const RUN_REASONS: Readonly<Record<string, string>> = {
  STAGE_HANDLER_MISSING: 'Paused: this step was not available when the lead reached it. It continues when the platform resumes halted pipelines.',
  NO_ACTIVE_SCORING_CONFIG: 'No active scoring configuration, so the lead was not scored.',
  STAGE_ERROR: 'This step failed. A super admin can see the details in the job inspector.',
  STAGE_RETRIES_EXHAUSTED: 'This step failed after several retries. A super admin can see the details in the job inspector.',
  NO_DRAFT: 'There was no draft to put up for approval.',
  NO_SENDABLE_DRAFT: 'No channel can carry this draft: the lead has no contact or consent for email or WhatsApp.',
  AWAITING_HUMAN_APPROVAL: 'Waiting for a person in the approval queue.',
  NOTHING_APPROVED: 'Nothing was approved for delivery.',
  APPROVAL_DECISION_INVALID: 'The approval record is inconsistent, so nothing was sent.',
  DRAFT_MISSING: 'The approved draft could not be found, so nothing was sent.',
  FIRST_TOUCH_UNAVAILABLE: 'The draft has no message for the approved channel, so nothing was sent.',
  LEAD_MERGED: 'This lead was merged into another lead; the pipeline continues there.',
  PIN_MISMATCH: 'The pipeline version changed after this lead arrived, so this run stopped.',
};

export function runReasonText(code: string): string {
  return RUN_REASONS[code] ?? 'The pipeline recorded a reason for this step that has no description yet.';
}

/** Lead.websiteStatus. */
export const WEBSITE_LABELS: Readonly<Record<string, string>> = {
  UNKNOWN: 'Not checked',
  PRESENT_UNVERIFIED: 'Listed, not checked',
  REACHABLE: 'Reachable',
  UNREACHABLE: 'Unreachable',
  BLOCKED: 'Blocked by the safety check',
  VERIFIED_ABSENT: 'No website',
  /** ADR-119: the source listing has no website (equal to the CSV label). */
  NOT_LISTED: 'No website listed',
};

/** AiDraft.trigger. */
export const TRIGGER_LABELS: Readonly<Record<string, string>> = { PIPELINE: 'Pipeline', MANUAL: 'Requested', LOCAL_EXPLICIT: 'Local template, requested' };

/** Review reasons on drafts and quotation versions: one sentence per code, on both pages. */
const REVIEW_REASONS: Readonly<Record<string, string>> = {
  UNKNOWN_SERVICE: 'The proposal named a service outside the catalog; it was dropped.',
  QTY_OUT_OF_BOUNDS: 'A proposed quantity was outside the price list limits.',
  DUPLICATE_SERVICE: 'The proposal listed a service twice.',
  NO_ITEMS: 'The proposal names no catalog service.',
  PRICE_MISSING: 'A service has no price in the active price list.',
  SERVICE_ARCHIVED: 'A service in it is archived.',
  TOTAL_ABOVE_SANITY_CAP: 'The total is above the review limit.',
  PRICING_MISSING: 'The workspace has no active price list.',
  TAX_NOT_CONFIGURED: 'Tax is not configured.',
  GENERATION_FAILED: 'The AI provider did not return a usable draft.',
  AI_NOT_CONFIGURED: 'No AI provider is configured for this workspace.',
  MODE_MISMATCH: 'The workspace mode does not match the process mode.',
};

/**
 * A review reason as a sentence. Accepts a bare code (draft reasons) or a stored reason object
 * (`{ code, capPaise? }` on quotation versions); the sanity cap is named from the stored value.
 */
export function reviewReasonText(reason: unknown): string {
  const record = typeof reason === 'object' && reason !== null ? (reason as { code?: unknown; capPaise?: unknown }) : null;
  const code = typeof reason === 'string' ? reason : typeof record?.code === 'string' ? record.code : null;
  if (code === 'TOTAL_ABOVE_SANITY_CAP' && typeof record?.capPaise === 'string' && /^\d+$/.test(record.capPaise)) {
    return `The total is above the ${formatINR(BigInt(record.capPaise))} review limit.`;
  }
  if (code !== null && Object.hasOwn(REVIEW_REASONS, code)) return REVIEW_REASONS[code]!;
  return 'Needs a review before approval.';
}

function humanize(code: string): string {
  const words = code.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
