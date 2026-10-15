// AT13, R27, user decision D4 (T23): bulk actions.
// - The pre-flight counts every selected row as eligible, skipped (with its reason codes, from the
//   shared dispatch eligibility function with sendIntent BULK) or failed: eligible + skipped +
//   failed == selected.
// - `bulk.run` applies the action to the eligible rows only (one queued dispatch each, sendIntent
//   BULK, initiatedBy the confirming user) and persists one result per row; the result survives a
//   reload (a fresh client reads the same rows).
// - Audit rows equal the actions taken (one dispatch.queue per queued row) and the counts equal
//   the dispatch preflight outcomes at the same clock (every queued row is SENT, none SKIPPED).
// - D4: a Maps lead with only an employee-attested B2B email basis is never part of a bulk send
//   (skipped ATTESTED_MANUAL_ONLY, no DispatchAttempt); a Maps lead never has WhatsApp opt-in.
// - Requests are idempotent by requestKey; another workspace's run is 404.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Lead } from '@/generated/prisma/client';
import { createBulkRunJob } from '@/server/jobs/handlers/bulk-run';
import { contactKey } from '@/server/security/contact-key';
import { getBulkRun, listBulkRuns, previewBulkAction, requestBulkRun } from '@/server/services/bulk/bulk';
import { userCtx } from '../quotes/support';
import { approvedTemplate, createDispatchHarness, createLead, DEPS, grantConsent, PEPPER, WS_A, type DispatchHarness } from '../dispatch/support';

let h: DispatchHarness;

beforeAll(async () => {
  h = await createDispatchHarness('bulk-actions', () => [createBulkRunJob({ deps: () => DEPS, mode: () => 'demo' })]);
  await h.db.workspaceSettings.update({ where: { workspaceId: WS_A }, data: { emailB2bAttestationEnabled: true } });
}, 120_000);

afterAll(async () => {
  await h?.destroy();
});

const EMAIL = { action: 'SEND_EMAIL' as const, subject: 'Teeth whitening this week', body: 'We have open slots this week. Reply to book.' };

async function suppressEmail(lead: Lead) {
  await h.db.suppression.create({
    data: { workspaceId: WS_A, channel: 'EMAIL', contactKey: contactKey(PEPPER, 'email', lead.emailNormalized!), reason: 'UNSUBSCRIBE', createdAt: new Date('2026-10-10T00:00:00.000Z') },
  });
}

describe('bulk send (AT13)', () => {
  let leads: Record<string, Lead>;
  let selection: string[];

  beforeAll(async () => {
    const optIn1 = await createLead(h.db);
    await grantConsent(h.db, optIn1, 'EMAIL');
    const optIn2 = await createLead(h.db);
    await grantConsent(h.db, optIn2, 'EMAIL');
    const noBasis = await createLead(h.db);
    const mapsAttested = await createLead(h.db, { source: 'GMAPS_EXTENSION' });
    await grantConsent(h.db, mapsAttested, 'EMAIL', 'B2B_ATTESTED');
    const suppressed = await createLead(h.db);
    await grantConsent(h.db, suppressed, 'EMAIL');
    await suppressEmail(suppressed);
    const noEmail = await createLead(h.db, { email: null });
    const merged = await createLead(h.db);
    await grantConsent(h.db, merged, 'EMAIL');
    await h.db.lead.update({ where: { id: merged.id }, data: { mergedIntoLeadId: optIn1.id } });
    leads = { optIn1, optIn2, noBasis, mapsAttested, suppressed, noEmail, merged };
    selection = Object.values(leads).map((l) => l.id);
  });

  it('pre-flight: eligible + skipped + failed == selected, with a reason per skipped and failed row', async () => {
    const owner = await h.owner();
    const preview = await previewBulkAction(owner, { leadIds: selection, ...EMAIL }, DEPS);
    expect(preview).toMatchObject({ selected: 7, eligible: 2, skipped: 3, failed: 2 });
    expect(preview.eligible + preview.skipped + preview.failed).toBe(preview.selected);
    const byLead = Object.fromEntries(preview.rows.map((r) => [r.leadId, r]));
    expect(byLead[leads.optIn1!.id]).toMatchObject({ outcome: 'ELIGIBLE', reasons: [], deferred: false });
    expect(byLead[leads.noBasis!.id]).toMatchObject({ outcome: 'SKIPPED', reasons: ['NO_EMAIL_BASIS'] });
    expect(byLead[leads.mapsAttested!.id]).toMatchObject({ outcome: 'SKIPPED', reasons: ['ATTESTED_MANUAL_ONLY'] });
    expect(byLead[leads.suppressed!.id]).toMatchObject({ outcome: 'SKIPPED', reasons: ['SUPPRESSED'] });
    expect(byLead[leads.noEmail!.id]).toMatchObject({ outcome: 'FAILED', reasons: ['CONTACT_MISSING'] });
    expect(byLead[leads.merged!.id]).toMatchObject({ outcome: 'FAILED', reasons: ['LEAD_MERGED'] });
    expect(preview.byReason).toEqual(
      expect.arrayContaining([
        { code: 'ATTESTED_MANUAL_ONLY', label: 'Attested B2B email allows manual single sends only', count: 1 },
        expect.objectContaining({ code: 'NO_EMAIL_BASIS', count: 1 }),
        expect.objectContaining({ code: 'SUPPRESSED', count: 1 }),
        expect.objectContaining({ code: 'CONTACT_MISSING', count: 1 }),
        expect.objectContaining({ code: 'LEAD_MERGED', count: 1 }),
      ]),
    );
    // The pre-flight writes nothing.
    expect(await h.db.message.count({ where: { workspaceId: WS_A } })).toBe(0);
    expect(await h.db.bulkRun.count()).toBe(0);
  });

  it('run: queues the eligible rows only, persists every row, audit and dispatch outcomes match the counts', async () => {
    const owner = await h.owner();
    const auditBefore = await h.db.auditEvent.count({ where: { workspaceId: WS_A, action: 'dispatch.queue' } });
    const run = await requestBulkRun(owner, { requestKey: 'bulk-email-0001', leadIds: selection, ...EMAIL }, DEPS);
    expect(run).toMatchObject({ status: 'QUEUED', selected: 7, preflight: { eligible: 2, skipped: 3, failed: 2 } });
    const again = await requestBulkRun(owner, { requestKey: 'bulk-email-0001', leadIds: selection, ...EMAIL }, DEPS);
    expect(again.id).toBe(run.id);
    await expect(requestBulkRun(owner, { requestKey: 'bulk-email-0001', leadIds: selection.slice(1), ...EMAIL }, DEPS)).rejects.toMatchObject({ status: 409 });
    expect(await h.db.job.count({ where: { type: 'bulk.run' } })).toBe(1);

    await h.drain();

    const done = await getBulkRun(owner, run.id);
    expect(done).toMatchObject({ status: 'COMPLETED', selected: 7, queued: 2, skipped: 3, failed: 2 });
    expect(done.queued + done.skipped + done.failed).toBe(done.selected);
    expect(done.rows.map((r) => r.leadId)).toEqual(selection);
    const skippedRows = done.rows.filter((r) => r.outcome === 'SKIPPED');
    expect(skippedRows).toHaveLength(3);
    for (const row of [...skippedRows, ...done.rows.filter((r) => r.outcome === 'FAILED')]) {
      expect(row.reasons.length).toBeGreaterThan(0);
      expect(row.reasons.every((r) => r.label.length > 0)).toBe(true);
    }

    // Exactly the queued rows have a Message and a DispatchAttempt (BULK, initiated by the owner).
    const attempts = await h.db.dispatchAttempt.findMany({ where: { workspaceId: WS_A }, include: { message: { include: { conversation: true } } } });
    expect(attempts.map((a) => a.message.conversation.leadId).sort()).toEqual([leads.optIn1!.id, leads.optIn2!.id].sort());
    expect(attempts.every((a) => a.sendIntent === 'BULK' && a.initiatedBy === owner.actor!.userId)).toBe(true);
    // D4: the attested Maps lead never got an attempt.
    expect(await h.db.message.count({ where: { conversation: { leadId: leads.mapsAttested!.id } } })).toBe(0);

    // Dispatch preflight at the same clock agrees: every queued row is sent, none skipped.
    expect(attempts.map((a) => a.state)).toEqual(['SENT', 'SENT']);
    expect(h.email.calls).toHaveLength(2);
    expect(await h.db.auditEvent.count({ where: { workspaceId: WS_A, action: 'dispatch.queue' } })).toBe(auditBefore + done.queued);
    expect(await h.db.auditEvent.count({ where: { workspaceId: WS_A, action: 'dispatch.sent' } })).toBe(done.queued);
    expect(await h.db.auditEvent.count({ where: { workspaceId: WS_A, action: 'bulk.run.request' } })).toBe(1);
    const complete = await h.db.auditEvent.findMany({ where: { workspaceId: WS_A, action: 'bulk.run.complete' } });
    expect(complete).toHaveLength(1);
    expect(complete[0]!.summary).toMatchObject({ queued: 2, skipped: 3, failed: 2 });

    // Results survive a reload: a fresh client reads the same persisted rows.
    const fresh = h.testDb.client();
    const reread = await getBulkRun(await userCtx(fresh, h.clock, 'owner'), run.id);
    expect(reread.rows).toEqual(done.rows);
    expect((await listBulkRuns(await userCtx(fresh, h.clock, 'owner'))).map((r) => r.id)).toContain(run.id);
  });

  it('another workspace cannot read the run (404), and foreign lead ids are refused (404)', async () => {
    const owner = await h.owner();
    const run = (await listBulkRuns(owner))[0]!;
    const other = await userCtx(h.db, h.clock, 'rohan');
    await expect(getBulkRun(other, run.id)).rejects.toMatchObject({ status: 404 });
    await expect(previewBulkAction(other, { leadIds: [selection[0]!], ...EMAIL }, DEPS)).rejects.toMatchObject({ status: 404 });
  });

  it('WhatsApp template bulk: a Maps lead has no WhatsApp opt-in, a Sheets opt-in lead is sent', async () => {
    const template = await approvedTemplate(h.db);
    const maps = await createLead(h.db, { source: 'GMAPS_EXTENSION' });
    const optIn = await createLead(h.db);
    await grantConsent(h.db, optIn, 'WHATSAPP');
    const owner = await h.owner();
    const input = { action: 'SEND_WHATSAPP_TEMPLATE' as const, templateId: template.id, variables: { '1': 'Smile Avenue' }, leadIds: [maps.id, optIn.id] };
    const preview = await previewBulkAction(owner, input, DEPS);
    expect(preview).toMatchObject({ selected: 2, eligible: 1, skipped: 1, failed: 0 });
    expect(preview.rows[0]).toMatchObject({ leadId: maps.id, outcome: 'SKIPPED', reasons: ['NO_WHATSAPP_OPT_IN'] });
    const run = await requestBulkRun(owner, { ...input, requestKey: 'bulk-wa-0001' }, DEPS);
    await h.drain();
    expect(await getBulkRun(owner, run.id)).toMatchObject({ status: 'COMPLETED', queued: 1, skipped: 1, failed: 0 });
    expect(h.wa.calls).toHaveLength(1);
    expect(await h.db.dispatchAttempt.count({ where: { message: { conversation: { leadId: maps.id } } } })).toBe(0);
  });

  it('paused outbound: eligible rows are queued as deferred (not skipped) and nothing is sent', async () => {
    const lead = await createLead(h.db);
    await grantConsent(h.db, lead, 'EMAIL');
    await h.db.systemSetting.upsert({ where: { id: 1 }, create: { id: 1, outboundPaused: true }, update: { outboundPaused: true } });
    try {
      const owner = await h.owner();
      const preview = await previewBulkAction(owner, { leadIds: [lead.id], ...EMAIL }, DEPS);
      expect(preview).toMatchObject({ eligible: 1, skipped: 0, failed: 0 });
      expect(preview.rows[0]).toMatchObject({ outcome: 'ELIGIBLE', deferred: true, reasons: ['GLOBAL_PAUSED'] });
      const callsBefore = h.email.calls.length;
      const run = await requestBulkRun(owner, { requestKey: 'bulk-paused-0001', leadIds: [lead.id], ...EMAIL }, DEPS);
      await h.drain();
      const done = await getBulkRun(owner, run.id);
      expect(done).toMatchObject({ queued: 1, skipped: 0, failed: 0 });
      expect(done.rows[0]).toMatchObject({ outcome: 'QUEUED', deferred: true });
      const attempt = await h.db.dispatchAttempt.findFirstOrThrow({ where: { message: { conversation: { leadId: lead.id } } } });
      expect(attempt.state).toBe('QUEUED');
      expect(h.email.calls.length).toBe(callsBefore);
    } finally {
      await h.db.systemSetting.update({ where: { id: 1 }, data: { outboundPaused: false } });
    }
  });

  it('refuses an empty or oversized selection and checks capabilities', async () => {
    const owner = await h.owner();
    await expect(previewBulkAction(owner, { leadIds: [], ...EMAIL }, DEPS)).rejects.toMatchObject({ status: 400 });
    const neha = await userCtx(h.db, h.clock, 'neha', 'ironpulse-fitness');
    await expect(previewBulkAction(neha, { leadIds: [selection[0]!], ...EMAIL }, DEPS)).rejects.toMatchObject({ status: 403 });
  });
});
