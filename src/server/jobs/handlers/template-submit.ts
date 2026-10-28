/**
 * `wa.templateSubmit` (ADR-123, slice F4; LIVE): submits one authored template to Meta outside any
 * transaction and settles the outcome in the fenced finalTx (`runTemplateSubmit` in
 * services/integrations/template-authoring.ts): created -> PENDING with the provider id and a
 * follow-up sync 60 s later; a timeout or "name exists" -> confirmed by that sync by name and
 * language, never a blind retry; a definite refusal -> back to DRAFT with the reason. DEMO never
 * enqueues it (the simulated review runs instead) and a DEMO process does nothing with it.
 */
import { getConfig } from '@/lib/config';
import { liveAdapterDepsFrom } from '@/server/services/integrations/live-adapters';
import { runTemplateSubmit, type TemplateJobDeps } from '@/server/services/integrations/template-authoring';
import { TEMPLATE_JOB_PAYLOAD_VERSION, TEMPLATE_SUBMIT_JOB } from '@/server/services/integrations/template-jobs';
import type { JobDefinition } from '../types';

export function templateJobDepsFromConfig(): TemplateJobDeps {
  const config = getConfig();
  const live = liveAdapterDepsFrom(config);
  return { keyRing: live.keyRing, graphVersion: live.graphVersion, storageDir: config.paths.storageDir, mode: config.mode };
}

export function createTemplateSubmitJob(options: { deps?: () => TemplateJobDeps } = {}): JobDefinition {
  const deps = options.deps ?? templateJobDepsFromConfig;
  return { type: TEMPLATE_SUBMIT_JOB, kind: 'send', payloadVersions: [TEMPLATE_JOB_PAYLOAD_VERSION], handler: (job) => runTemplateSubmit(job, deps()) };
}

export const templateSubmitJob = createTemplateSubmitJob();
