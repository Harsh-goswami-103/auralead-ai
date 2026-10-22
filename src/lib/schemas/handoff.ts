/**
 * Lead handoff schemas and read DTOs (ADR-124, lead-gen slice F5), shared by the routes, the
 * services and both panels (plan §2: one schema set). Shape only; the domain rules (stage version,
 * a second handoff, a lost or merged lead) are the service's and answer with a code.
 *
 * The AI summary is stored in `LeadHandoff.summary` as JSON of `HandoffSummaryContent` (what the
 * customer asked, what was promised, the next step), so the client panel can show three labelled
 * lines; `parseStoredHandoffSummary` reads it back and ignores anything that is not that shape.
 */
import { z } from 'zod';
import type { HandoffSummaryStatus } from '../domain/lead-gen';
import { workspaceSlugField } from './lead-console';

/** Characters of the operator's note to the client. */
export const HANDOFF_NOTE_MAX = 1000;
/** Characters of each summary line. */
export const HANDOFF_SUMMARY_FIELD_MAX = 400;

/** A client-generated key per "Hand over" click: a double click or retry returns the same handoff. */
export const HandoffRequestKey = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'requestKey must be 8-64 letters, digits, _ or -');

export const LeadHandoffBody = z.object({
  workspaceSlug: workspaceSlugField.optional(),
  /** The lead's stageVersion the person saw; a newer one answers 409. */
  expectedStageVersion: z.number().int().min(0),
  /** What the client should know (shown to the client; never written to the audit trail). */
  note: z.string().trim().max(HANDOFF_NOTE_MAX).optional(),
  requestKey: HandoffRequestKey,
});
export type LeadHandoffBody = z.output<typeof LeadHandoffBody>;

/** The model's (and the local generator's) output, and what `LeadHandoff.summary` stores as JSON. */
export const HandoffSummaryContent = z
  .object({
    asked: z.string().trim().min(1).max(HANDOFF_SUMMARY_FIELD_MAX),
    promised: z.string().trim().min(1).max(HANDOFF_SUMMARY_FIELD_MAX),
    nextStep: z.string().trim().min(1).max(HANDOFF_SUMMARY_FIELD_MAX),
  })
  .strict();
export type HandoffSummaryContent = z.output<typeof HandoffSummaryContent>;

export const HANDOFF_SUMMARY_LABELS: Readonly<Record<keyof HandoffSummaryContent, string>> = {
  asked: 'What they asked',
  promised: 'What was promised',
  nextStep: 'Next step',
};

/** The stored summary, or null when there is none or it is not the expected shape. */
export function parseStoredHandoffSummary(text: string | null | undefined): HandoffSummaryContent | null {
  if (!text) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = HandoffSummaryContent.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export type HandoffStatusValue = 'HANDED_OVER' | 'ACKNOWLEDGED';

export const HANDOFF_STATUS_LABELS: Readonly<Record<HandoffStatusValue, string>> = {
  HANDED_OVER: 'Handed over',
  ACKNOWLEDGED: 'Acknowledged',
};

/** One handoff as both panels show it. Times are ISO strings. */
export type LeadHandoffDto = {
  id: string;
  leadId: string;
  status: HandoffStatusValue;
  note: string | null;
  summary: HandoffSummaryContent | null;
  summaryStatus: HandoffSummaryStatus;
  summaryGeneratorLabel: string | null;
  fromUserName: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
  acknowledgedByName: string | null;
};

export type HandoffListItemDto = LeadHandoffDto & { lead: { id: string; displayName: string; salesStage: string } };

export type HandOverResultDto = {
  handoffId: string;
  /** False when the same request key was replayed: the earlier handoff is returned. */
  created: boolean;
  summaryStatus: HandoffSummaryStatus;
  lead: { id: string; salesStage: string; stageVersion: number; handedOverAt: string };
};

export type AcknowledgeResultDto = { handoffId: string; status: HandoffStatusValue; changed: boolean };
