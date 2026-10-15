// O5, R29, P11, ADR-27 (T23): a lead runs the PipelineConfigVersion it was pinned to at ingestion.
// - Activating v2 leaves in-flight leads on v1: a lead ingested under HUMAN v1 whose pipeline is
//   still queued when POLICY_AUTO v2 is activated finishes on v1 (pending approval, no send).
// - Switching HUMAN to POLICY_AUTO never sends approvals already waiting in the queue.
// - Leads ingested after the activation run v2 and are auto-sent (after the same dispatch checks).
// - Saving a version runs the validator (POLICY_AUTO needs auto-send) and a version CAS.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestBatch } from '@/server/services/leads/ingest';
import { getPipelineConfig, savePipelineConfig } from '@/server/services/pipeline/config';
import { PIPELINE_V1 } from '../../../prisma/seed/fixtures/configs';
import { CONSENT_MAPPING, createPipelineHarness, DEPS, firstTouchTemplate, ingestSheetsLead, setAutoSend, stageRuns, webhookCtx, WS_A, type PipelineHarness } from './support';

let h: PipelineHarness;

beforeAll(async () => {
  h = await createPipelineHarness('pipeline-pinned');
  await firstTouchTemplate(h.db, WS_A);
}, 120_000);

afterAll(async () => {
  await h?.destroy();
});

async function pendingApprovalsFor(leadId: string) {
  return h.db.approval.findMany({ where: { workspaceId: WS_A, status: 'PENDING', message: { conversation: { leadId } } } });
}

describe('pinned pipeline version (O5)', () => {
  it('refuses POLICY_AUTO while auto-send is off, and a stale expected version', async () => {
    const owner = await h.owner();
    await expect(savePipelineConfig(owner, { graph: PIPELINE_V1, approvalMode: 'POLICY_AUTO', expectedVersion: 1 })).rejects.toMatchObject({
      status: 422,
      code: 'PIPELINE_INVALID',
      safeDetails: { issues: [expect.objectContaining({ code: 'POLICY_AUTO_REQUIRES_AUTO_SEND' })] },
    });
    await expect(savePipelineConfig(owner, { graph: PIPELINE_V1, approvalMode: 'HUMAN', expectedVersion: 7 })).rejects.toMatchObject({ status: 409, code: 'PIPELINE_VERSION_CONFLICT' });
    const view = await getPipelineConfig(owner);
    expect(view.active).toMatchObject({ version: 1, approvalMode: 'HUMAN' });
  });

  it('activating POLICY_AUTO v2 leaves v1 leads on v1 and never sends their queued approvals', async () => {
    // L1 runs the whole HUMAN v1 pipeline: its first touch waits in the approval queue.
    const l1 = await ingestSheetsLead(h, 'l1', '+91 98555 40001');
    await h.drain();
    expect(await pendingApprovalsFor(l1.leadId)).toHaveLength(1);

    // L2 is ingested under v1 but its pipeline has not run yet when v2 is activated.
    const l2 = await ingestSheetsLead(h, 'l2', '+91 98555 40002');
    await setAutoSend(h.db, WS_A, true);
    const owner = await h.owner();
    const saved = await savePipelineConfig(owner, { graph: PIPELINE_V1, approvalMode: 'POLICY_AUTO', expectedVersion: 1 });
    expect(saved).toMatchObject({ version: 2, approvalMode: 'POLICY_AUTO', active: true });
    const versions = await h.db.pipelineConfigVersion.findMany({ where: { workspaceId: WS_A }, orderBy: { version: 'asc' } });
    expect(versions.map((v) => [v.version, v.active])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(await h.db.auditEvent.count({ where: { workspaceId: WS_A, action: 'pipeline.config.activate' } })).toBe(1);

    await h.drain();
    for (const lead of [l1, l2]) {
      const execution = await h.db.pipelineExecution.findUniqueOrThrow({ where: { leadId: lead.leadId } });
      expect(execution.pipelineConfigVersionId).toBe(versions[0]!.id);
      const runs = await stageRuns(h.db, execution.id);
      expect(runs.APPROVAL!.outputRef).toMatchObject({ decision: 'HUMAN_REVIEW' });
      expect(runs.DELIVERY).toMatchObject({ status: 'SKIPPED', reasonCode: 'AWAITING_HUMAN_APPROVAL' });
      expect(await pendingApprovalsFor(lead.leadId)).toHaveLength(1);
    }
    expect(await h.db.dispatchAttempt.count({ where: { workspaceId: WS_A } })).toBe(0);
    expect(h.outbox('whatsapp')).toHaveLength(0);

    // L3 arrives after the activation: pinned to v2, approved by policy and sent once.
    const l3 = await ingestSheetsLead(h, 'l3', '+91 98555 40003');
    expect(l3.execution.pipelineConfigVersionId).toBe(versions[1]!.id);
    await h.drain();
    const attempts = await h.db.dispatchAttempt.findMany({ where: { workspaceId: WS_A } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ state: 'SENT', sendIntent: 'AUTOMATED' });
    expect(h.outbox('whatsapp')).toHaveLength(1);
    // The v1 approvals are still waiting for a person.
    expect(await pendingApprovalsFor(l1.leadId)).toHaveLength(1);
    expect(await pendingApprovalsFor(l2.leadId)).toHaveLength(1);
  });

  it('POLICY_AUTO routes a lead it may not auto-send to a person instead (no opt-in: human review)', async () => {
    // A Sheets row without the consent answer: no WhatsApp opt-in, so policy cannot approve.
    const result = await ingestBatch(
      webhookCtx(h),
      { source: 'GOOGLE_SHEETS', externalBatchId: 'pipeline-noconsent', mapping: CONSENT_MAPPING, records: [{ externalId: 'row-nc', fields: { name: 'No Consent Lead', phone: '+91 98555 40004' }, submittedAt: '2026-10-15T08:00:00.000Z' }] },
      DEPS,
    );
    const leadId = result.records[0]!.leadId!;
    await h.drain();
    const execution = await h.db.pipelineExecution.findUniqueOrThrow({ where: { leadId } });
    const runs = await stageRuns(h.db, execution.id);
    expect(runs.APPROVAL!.outputRef).toMatchObject({ decision: 'HUMAN_REVIEW', blockers: expect.arrayContaining(['NOT_ELIGIBLE']), reasons: expect.arrayContaining(['NO_WHATSAPP_OPT_IN']) });
    expect(runs.DELIVERY).toMatchObject({ status: 'SKIPPED', reasonCode: 'AWAITING_HUMAN_APPROVAL' });
    expect(await pendingApprovalsFor(leadId)).toHaveLength(1);
    expect(await h.db.dispatchAttempt.count({ where: { workspaceId: WS_A, message: { conversation: { leadId } } } })).toBe(0);
  });
});
