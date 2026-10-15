/**
 * INGESTION stage (T10). The lead row, its source record, contact keys, consent and the pinned
 * execution were all written by `ingestBatch` in one transaction; this stage confirms the
 * execution can proceed and records what entered the pipeline:
 * - FAILED `LEAD_MERGED` when the lead has since been merged into another lead (the surviving
 *   lead's own execution carries on; this one stops visibly);
 * - FAILED `PIN_MISMATCH` when the lead's pinned PipelineConfigVersion differs from the
 *   execution's (O5: a pin never changes after ingestion, so this signals corruption);
 * - otherwise DONE with `{ leadId, firstSource, sourceRecords, pipelineVersion }`.
 */
import type { StageHandler } from './types';

export const ingestionStage: StageHandler = {
  stage: 'INGESTION',
  async run({ ctx, lead, execution, config }) {
    if (lead.mergedIntoLeadId !== null) return { status: 'FAILED', reasonCode: 'LEAD_MERGED', outputRef: { mergedIntoLeadId: lead.mergedIntoLeadId } };
    if (lead.pipelineConfigVersionId !== execution.pipelineConfigVersionId) return { status: 'FAILED', reasonCode: 'PIN_MISMATCH' };
    const sourceRecords = await ctx.db.leadSourceRecord.count({ where: { leadId: lead.id } });
    return {
      status: 'DONE',
      outputRef: { leadId: lead.id, firstSource: lead.firstSource, sourceRecords, pipelineVersion: config.version },
    };
  },
};
