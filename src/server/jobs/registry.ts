/**
 * Job handler registry. The worker builds one with `buildJobRegistry()`; tasks that add a job type
 * (T10 pipeline.advance, T11 ingest.process, ...) register its definition in `JOB_DEFINITIONS`.
 * A claimed job whose type is not registered goes DEAD with UNKNOWN_JOB_TYPE (never silently
 * dropped or retried).
 */
import { leadEnrichJob } from './handlers/lead-enrich';
import { leadRescoreJob } from './handlers/lead-rescore';
import { leadScoreJob } from './handlers/lead-score';
import { pipelineAdvanceJob } from './handlers/pipeline-advance';
import { ingestProcessJob } from './handlers/ingest-process';
import { webhookPurgeJob } from './handlers/webhook-purge';
import { aiDraftJob } from './handlers/ai-draft';
import { quoteExpireSweepJob } from './handlers/quote-expire-sweep';
import { quoteRenderPdfJob } from './handlers/quote-render-pdf';
import { suppressionJournalReconcileJob } from './handlers/suppression-journal-reconcile';
import { dispatchWhatsAppJob } from './handlers/dispatch-whatsapp';
import { dispatchEmailJob } from './handlers/dispatch-email';
import { bulkRunJob } from './handlers/bulk-run';
import { webhookProcessJob } from './handlers/webhook-process';
import { statusApplyJob } from './handlers/status-apply';
import { replyAutoJob } from './handlers/reply-auto';
import { leadExportJob, leadExportPurgeJob } from './handlers/lead-export';
import { integrationHealthJob } from './handlers/integration-health';
import { waQualityCheckJob } from './handlers/wa-quality-check';
import { templateSyncJob } from './handlers/template-sync';
import { metaLeadBackfillJob, metaLeadFetchJob } from './handlers/meta-lead-fetch';
import { campaignActionJob, campaignReadBackJob } from './handlers/campaign-action';
import { campaignMetricsSyncJob } from './handlers/campaign-metrics-sync';
import { sheetsSyncJob } from './handlers/sheets-sync';
// Lead-gen suite handlers (docs/handoff/lead-gen-suite-plan.md §6): each slice imports only inside its block.
// ---- lead-gen F1 finder ----
import { leadFinderSearchJob } from './handlers/lead-finder-search';
import { leadFinderPurgeJob } from './handlers/lead-finder-purge';
// ---- end F1 ----
// ---- lead-gen F2 import ----

// ---- end F2 ----
// ---- lead-gen F3 chat ----

// ---- end F3 ----
// ---- lead-gen F4 templates ----

// ---- end F4 ----
// ---- lead-gen F5 handoff ----

// ---- end F5 ----
// ---- lead-gen F6 presentation ----

// ---- end F6 ----
import type { JobDefinition } from './types';

export class JobRegistry {
  readonly #defs = new Map<string, JobDefinition>();

  register(def: JobDefinition): this {
    if (!/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+)+$/.test(def.type)) throw new Error(`invalid job type name: ${def.type}`);
    if (this.#defs.has(def.type)) throw new Error(`job type already registered: ${def.type}`);
    if (def.payloadVersions.length === 0 || !def.payloadVersions.every((v) => Number.isInteger(v) && v > 0)) {
      throw new Error(`job type ${def.type}: payloadVersions must be positive integers`);
    }
    this.#defs.set(def.type, def);
    return this;
  }

  get(type: string): JobDefinition | undefined {
    return this.#defs.get(type);
  }

  types(): string[] {
    return [...this.#defs.keys()].sort();
  }
}

/** Production job definitions, appended by the tasks that own each handler. */
export const JOB_DEFINITIONS: readonly JobDefinition[] = [
  pipelineAdvanceJob,
  leadEnrichJob,
  leadScoreJob,
  leadRescoreJob,
  ingestProcessJob,
  webhookPurgeJob,
  aiDraftJob,
  quoteExpireSweepJob,
  quoteRenderPdfJob,
  suppressionJournalReconcileJob,
  dispatchWhatsAppJob,
  dispatchEmailJob,
  bulkRunJob,
  webhookProcessJob,
  statusApplyJob,
  replyAutoJob,
  leadExportJob,
  leadExportPurgeJob,
  integrationHealthJob,
  waQualityCheckJob,
  templateSyncJob,
  metaLeadFetchJob,
  metaLeadBackfillJob,
  campaignMetricsSyncJob,
  campaignActionJob,
  campaignReadBackJob,
  sheetsSyncJob,
  // Lead-gen suite job types (LEAD_GEN_JOB_TYPES in src/lib/domain/lead-gen.ts), each in its slice's block.
  // ---- lead-gen F1 finder ----
  leadFinderSearchJob,
  leadFinderPurgeJob,
  // ---- end F1 ----
  // ---- lead-gen F2 import ----

  // ---- end F2 ----
  // ---- lead-gen F3 chat ----

  // ---- end F3 ----
  // ---- lead-gen F4 templates ----

  // ---- end F4 ----
  // ---- lead-gen F5 handoff ----

  // ---- end F5 ----
  // ---- lead-gen F6 presentation ----

  // ---- end F6 ----
];

export function buildJobRegistry(defs: readonly JobDefinition[] = JOB_DEFINITIONS): JobRegistry {
  const registry = new JobRegistry();
  for (const def of defs) registry.register(def);
  return registry;
}
