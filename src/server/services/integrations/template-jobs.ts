/**
 * Job names, payloads and idempotency keys of the template studio (ADR-123, slice F4), shared by
 * the studio service, its two job handlers and the template sync (which must know whether a
 * submission is still in flight before it calls one unconfirmed).
 *
 *  - `wa.templateSubmit` (LIVE, kind send): one per submission, keyed by the template and the
 *    submission time, so a resubmission after a definite failure gets its own job.
 *  - `wa.templateReview` (DEMO, simulated): one per submission, 30 s after it.
 *  - `wa.templateSync` keyed `wa.templateSync:<integrationId>:submit:<templateId>:<submittedAt>`:
 *    the follow-up sync at least 60 s after a LIVE submission (the existing sync job type).
 */
import { LEAD_GEN_JOB_TYPES } from '@/lib/domain/lead-gen';
import { WA_TEMPLATE_SYNC_JOB } from './schedules';

export const TEMPLATE_SUBMIT_JOB = LEAD_GEN_JOB_TYPES.templateSubmit;
export const TEMPLATE_REVIEW_JOB = LEAD_GEN_JOB_TYPES.templateReview;
export const TEMPLATE_JOB_PAYLOAD_VERSION = 1;

/** The follow-up sync runs at least this long after a LIVE submission (ADR-123). */
export const SUBMIT_SYNC_DELAY_MS = 60_000;
/** A SUBMITTING row younger than this is never called unconfirmed by a sync. */
export const SUBMIT_RESOLVE_AFTER_MS = 60_000;

export function templateSubmitJobKeyPrefix(templateId: string): string {
  return `${TEMPLATE_SUBMIT_JOB}:${templateId}:`;
}

export function templateSubmitJobKey(templateId: string, submittedAt: Date): string {
  return `${templateSubmitJobKeyPrefix(templateId)}${submittedAt.getTime()}`;
}

export function templateReviewJobKey(templateId: string, submittedAt: Date): string {
  return `${TEMPLATE_REVIEW_JOB}:${templateId}:${submittedAt.getTime()}`;
}

export function submitSyncJobKey(integrationId: string, templateId: string, submittedAt: Date): string {
  return `${WA_TEMPLATE_SYNC_JOB}:${integrationId}:submit:${templateId}:${submittedAt.getTime()}`;
}
