// O2, E3, ADR-15, ADR-37: re-opt-in after Stop is ordered against the LATEST Stop for the contact
// and channel, and suppression is append-only history.
// - A delayed form row whose submission time is older than the Stop never clears it.
// - Undated evidence never clears it (ingestion records nothing without a submission time; a manual
//   grant without an evidence time is refused).
// - A START keyword received after the Stop clears it (clearedAt, clearedByConsentId, audit).
// - Stop, START, Stop, then a delayed consent older than the second Stop: still suppressed, and the
//   history shows 2 rows, 1 cleared. Equal timestamps do not clear (strictly newer only).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contactKey } from '@/server/security/contact-key';
import { checkDispatchEligibility } from '@/server/services/messaging/eligibility';
import { grantManualConsent, recordStartKeywordConsent } from '@/server/services/messaging/consent';
import { recordSuppression, withSuppressionTx } from '@/server/services/messaging/suppression';
import { ingestBatch } from '@/server/services/leads/ingest';
import { DEPS } from '../ingest/support';
import { userCtx } from '../quotes/support';
import { createConsentHarness, ensureWhatsApp, journalLines, PEPPER, suppressionRows, wsCtx, type ConsentHarness } from './support';

let h: ConsentHarness;
let templateId: string;

beforeAll(async () => {
  h = await createConsentHarness('reoptin');
  templateId = (await ensureWhatsApp(h.db)).approved.id;
});
afterAll(async () => {
  await h.cleanup();
});

const PHONE = '+919845500001';
const KEY = contactKey(PEPPER, 'phone', PHONE);
const NOTICE = 'I agree to receive offers from Smile Avenue Dental on WhatsApp. Reply STOP to opt out.';
const CONSENT_MAPPING = { version: 1, formId: 'sheet-reoptin', consent: { column: 'consent', truthyValues: ['yes'], channel: 'WHATSAPP' as const, purpose: 'MARKETING' as const, noticeText: NOTICE } };

async function formRow(batchId: string, submittedAt: string | undefined) {
  const result = await ingestBatch(
    wsCtx(h),
    { source: 'GOOGLE_SHEETS', externalBatchId: batchId, mapping: CONSENT_MAPPING, records: [{ externalId: batchId, fields: { name: 'Meera Iyer', phone: PHONE }, answers: { consent: 'yes' }, submittedAt }] },
    DEPS,
  );
  return result.records[0]!;
}

async function templateEligibility(leadId: string) {
  const ctx = wsCtx(h);
  return checkDispatchEligibility(ctx.db, ctx, { leadId, channel: 'WHATSAPP', kind: 'WA_TEMPLATE', sendIntent: 'MANUAL_SINGLE', templateId }, h.deps);
}

async function stop(at: string, sourceEventId: string) {
  h.clock.set(at);
  return recordSuppression(wsCtx(h), { channel: 'WHATSAPP', contact: { kind: 'phone', value: PHONE }, reason: 'STOP_KEYWORD', sourceEventId }, h.deps);
}

async function start(at: string, leadId: string, messageId: string) {
  h.clock.set(at);
  const ctx = wsCtx(h);
  return withSuppressionTx(ctx, h.deps, (tx, batch) => recordStartKeywordConsent(tx, ctx, batch, { leadId, phoneE164: PHONE, providerTs: new Date(at), messageId }, PEPPER));
}

describe('re-opt-in ordering against the latest Stop (O2, E3)', () => {
  let leadId: string;

  it('the lead opts in through a form, then sends STOP', async () => {
    h.clock.set('2026-10-16T08:00:00.000Z');
    const row = await formRow('row-initial', '2026-10-16T07:00:00.000Z');
    expect(row.status).toBe('ACCEPTED');
    leadId = row.leadId!;
    expect((await templateEligibility(leadId)).eligible).toBe(true);

    const s = await stop('2026-10-16T10:00:00.000Z', 'wa:stop-1');
    expect(s.outcome).toBe('CREATED');
    const r = await templateEligibility(leadId);
    expect(r.reasons).toEqual(['SUPPRESSED']);
  });

  it('a delayed form row older than the Stop is recorded but does not clear it', async () => {
    h.clock.set('2026-10-16T10:30:00.000Z');
    const row = await formRow('row-delayed', '2026-10-16T09:00:00.000Z');
    expect(row.consent.outcome).toBe('CREATED');
    const rows = await suppressionRows(h.db, KEY);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.clearedAt).toBeNull();
    expect((await templateEligibility(leadId)).reasons).toEqual(['SUPPRESSED']);
    const refused = await h.db.auditEvent.findMany({ where: { action: 'suppression.clear_refused', targetId: rows[0]!.id } });
    expect(refused).toHaveLength(1);
    expect(refused[0]!.summary).toMatchObject({ reasonCode: 'EVIDENCE_NOT_NEWER' });
  });

  it('undated evidence never clears it', async () => {
    // Ingestion: a truthy consent answer without a submission time records nothing.
    h.clock.set('2026-10-16T10:40:00.000Z');
    const row = await formRow('row-undated', undefined);
    expect(row.consent).toEqual({ outcome: 'NONE', reason: 'NO_EVIDENCE_TIME' });
    // A manual grant must name its evidence time.
    const owner = await userCtx(h.db, h.clock, 'owner');
    await expect(
      grantManualConsent(owner, { leadId, channel: 'WHATSAPP', purpose: 'MARKETING', source: 'MANUAL_EVIDENCE', evidence: { note: 'Customer said yes on a call' } } as never, h.deps),
    ).rejects.toMatchObject({ status: 400 });
    expect((await suppressionRows(h.db, KEY))[0]!.clearedAt).toBeNull();
    expect((await templateEligibility(leadId)).reasons).toEqual(['SUPPRESSED']);
  });

  it('evidence with exactly the Stop time does not clear it (strictly newer only)', async () => {
    const owner = await userCtx(h.db, h.clock, 'owner');
    h.clock.set('2026-10-16T10:45:00.000Z');
    const result = await grantManualConsent(
      owner,
      { leadId, channel: 'WHATSAPP', purpose: 'MARKETING', source: 'MANUAL_EVIDENCE', collectedAt: '2026-10-16T10:00:00.000Z', evidence: { note: 'Signed form scanned at the clinic desk' } },
      h.deps,
    );
    expect(result.reoptIn).toBe('EVIDENCE_NOT_NEWER');
    expect((await suppressionRows(h.db, KEY))[0]!.clearedAt).toBeNull();
  });

  it('a START keyword after the Stop clears it, with audit and a CLEAR journal line', async () => {
    const result = await start('2026-10-16T11:00:00.000Z', leadId, 'wamid.START1');
    expect(result.reoptIn).toBe('CLEARED');
    const rows = await suppressionRows(h.db, KEY);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.clearedAt?.toISOString()).toBe('2026-10-16T11:00:00.000Z');
    expect(rows[0]!.clearedByConsentId).toBe(result.consentId);
    const consent = await h.db.consentRecord.findUniqueOrThrow({ where: { id: result.consentId } });
    expect(consent).toMatchObject({ basis: 'OPT_IN', source: 'START_KEYWORD', channel: 'WHATSAPP', purpose: 'MARKETING', contactKey: KEY });
    expect(await h.db.auditEvent.count({ where: { action: 'suppression.clear', targetId: rows[0]!.id } })).toBe(1);
    expect((await journalLines(h.journalDir)).filter((l) => l.action === 'CLEAR' && l.suppressionId === rows[0]!.id)).toHaveLength(1);
    expect((await templateEligibility(leadId)).eligible).toBe(true);
  });

  it('Stop, START, Stop, then a delayed consent older than the second Stop: stays suppressed; history 2 rows, 1 cleared', async () => {
    const second = await stop('2026-10-16T12:00:00.000Z', 'wa:stop-2');
    expect(second.outcome).toBe('CREATED');
    expect((await templateEligibility(leadId)).reasons).toEqual(['SUPPRESSED']);

    // Newer than the first Stop (and the START), older than the second Stop.
    h.clock.set('2026-10-16T12:30:00.000Z');
    const row = await formRow('row-delayed-2', '2026-10-16T11:30:00.000Z');
    expect(row.consent.outcome).toBe('CREATED');
    const owner = await userCtx(h.db, h.clock, 'owner');
    const manual = await grantManualConsent(
      owner,
      { leadId, channel: 'WHATSAPP', purpose: 'MARKETING', source: 'MANUAL_EVIDENCE', collectedAt: '2026-10-16T11:45:00.000Z', evidence: { note: 'Paper form dated before the second stop' } },
      h.deps,
    );
    expect(manual.reoptIn).toBe('EVIDENCE_NOT_NEWER');

    const rows = await suppressionRows(h.db, KEY);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.clearedAt !== null)).toHaveLength(1);
    expect(rows[1]!.clearedAt).toBeNull();
    expect((await templateEligibility(leadId)).reasons).toEqual(['SUPPRESSED']);
  });

  it('a Stop while a row is active is a no-op plus audit', async () => {
    const again = await stop('2026-10-16T12:40:00.000Z', 'wa:stop-3');
    expect(again.outcome).toBe('ALREADY_ACTIVE');
    expect(await suppressionRows(h.db, KEY)).toHaveLength(2);
    expect(await h.db.auditEvent.count({ where: { action: 'suppression.stop_repeat' } })).toBe(1);
  });

  it('a manual opt-in strictly newer than the latest Stop clears the second row; rows are never deleted', async () => {
    const owner = await userCtx(h.db, h.clock, 'owner');
    h.clock.set('2026-10-16T13:00:00.000Z');
    const manual = await grantManualConsent(
      owner,
      { leadId, channel: 'WHATSAPP', purpose: 'MARKETING', source: 'MANUAL_EVIDENCE', collectedAt: '2026-10-16T12:50:00.000Z', evidence: { note: 'Customer re-subscribed at the front desk', reference: 'desk-log-17' } },
      h.deps,
    );
    expect(manual.reoptIn).toBe('CLEARED');
    const rows = await suppressionRows(h.db, KEY);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.clearedAt !== null)).toBe(true);
    expect((await templateEligibility(leadId)).eligible).toBe(true);
  });
});
