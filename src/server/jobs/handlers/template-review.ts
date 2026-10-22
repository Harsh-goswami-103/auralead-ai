/**
 * `wa.templateReview` (ADR-123, slice F4; DEMO): the simulated WhatsApp Manager's review, 30 s
 * after a DEMO submission. It approves the template, or rejects a name containing `reject` with a
 * reason, and audits it simulated (`runTemplateReview` in
 * services/integrations/template-authoring.ts). Zero network; a LIVE process does nothing with it.
 */
import { getConfig } from '@/lib/config';
import { runTemplateReview } from '@/server/services/integrations/template-authoring';
import { TEMPLATE_JOB_PAYLOAD_VERSION, TEMPLATE_REVIEW_JOB } from '@/server/services/integrations/template-jobs';
import type { JobDefinition } from '../types';

export function createTemplateReviewJob(options: { mode?: () => 'demo' | 'live' } = {}): JobDefinition {
  const mode = options.mode ?? (() => getConfig().mode);
  return { type: TEMPLATE_REVIEW_JOB, kind: 'default', payloadVersions: [TEMPLATE_JOB_PAYLOAD_VERSION], handler: (job) => runTemplateReview(job, { mode: mode() }) };
}

export const templateReviewJob = createTemplateReviewJob();
