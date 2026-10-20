// T26, R31, R4: the lead detail sheet's read model. Consent is shown per channel and matched by
// the contact HMAC exactly like eligibility (an active opt-out wins over any consent; then an
// opt-in, an attested B2B email basis, or the customer's own message; a missing contact says so),
// the score breakdown is the stored snapshot, and the source records show source, status,
// attribution and batch without the raw payload. Another workspace's lead is 404.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contactKey } from '@/server/security/contact-key';
import { loadLeadProfile } from '@/server/services/leads/profile';
import { createQuoteHarness, makeLeads, ownerCtx, userCtx, WS_A, WS_B, type QuoteHarness } from './support';

let h: QuoteHarness;
const PEPPER = 'lead-profile-test-pepper-0123456789abcdef';
const deps = { contactKeyPepper: PEPPER };

beforeAll(async () => {
  h = await createQuoteHarness('lead-profile');
}, 120_000);

afterAll(async () => {
  await h?.testDb.destroy();
});

describe('loadLeadProfile', () => {
  it('shows consent per channel by contact key: opt-out first, then opt-in, attestation, inbound', async () => {
    const [a, b, c] = await makeLeads(h.db, WS_A, [
      { name: 'Profile Opted In', phone: '+919811100001', email: 'optout@example.test' },
      { name: 'Profile Inbound', phone: '+919811100002', email: 'attested@example.test' },
      { name: 'Profile No Email', phone: '+919811100003', email: null },
    ]);
    const now = h.clock.now();
    const consent = (leadId: string, channel: 'WHATSAPP' | 'EMAIL', value: string, basis: 'OPT_IN' | 'INBOUND_MESSAGE' | 'B2B_ATTESTED', source: 'SHEETS_FORM' | 'INBOUND_MESSAGE' | 'EMPLOYEE_ATTESTATION', purpose: 'MARKETING' | 'SERVICE_CONVERSATION' = 'MARKETING') =>
      h.db.consentRecord.create({
        data: { workspaceId: WS_A, leadId, contactKey: contactKey(PEPPER, channel === 'WHATSAPP' ? 'phone' : 'email', value), channel, purpose, basis, source, evidence: {}, collectedAt: new Date(now.getTime() - 3_600_000), recordedAt: now },
      });
    await consent(a!.id, 'WHATSAPP', '+919811100001', 'OPT_IN', 'SHEETS_FORM');
    await consent(a!.id, 'EMAIL', 'optout@example.test', 'OPT_IN', 'SHEETS_FORM');
    await h.db.suppression.create({ data: { workspaceId: WS_A, channel: 'EMAIL', contactKey: contactKey(PEPPER, 'email', 'optout@example.test'), reason: 'UNSUBSCRIBE', createdAt: now } });
    await consent(b!.id, 'WHATSAPP', '+919811100002', 'INBOUND_MESSAGE', 'INBOUND_MESSAGE', 'SERVICE_CONVERSATION');
    await consent(b!.id, 'EMAIL', 'attested@example.test', 'B2B_ATTESTED', 'EMPLOYEE_ATTESTATION');
    // A consent recorded for another number of the same lead does not count for its current number.
    await consent(c!.id, 'WHATSAPP', '+919899999999', 'OPT_IN', 'SHEETS_FORM');

    const owner = await ownerCtx(h);
    const pa = await loadLeadProfile(owner, a!.id, deps);
    expect(pa.consent).toEqual([
      { channel: 'WHATSAPP', state: 'OPT_IN', since: new Date(now.getTime() - 3_600_000).toISOString(), source: 'SHEETS_FORM' },
      { channel: 'EMAIL', state: 'OPTED_OUT', since: now.toISOString(), source: 'UNSUBSCRIBE' },
    ]);
    const pb = await loadLeadProfile(owner, b!.id, deps);
    expect(pb.consent.map((x) => x.state)).toEqual(['CUSTOMER_MESSAGED', 'B2B_ATTESTED']);
    const pc = await loadLeadProfile(owner, c!.id, deps);
    expect(pc.consent.map((x) => x.state)).toEqual(['NONE', 'NO_CONTACT']);
    expect(pc.lead).toMatchObject({ displayName: 'Profile No Email', stageVersion: 0, salesStage: 'NEW', merged: false });
    expect(pc.permissions.canMoveStage).toBe(true);
  });

  it('lists the source records with attribution and batch, and the stored score breakdown', async () => {
    const [lead] = await makeLeads(h.db, WS_A, [{ name: 'Profile Sourced', source: 'META_ADS', score: 61 }]);
    await h.db.lead.update({
      where: { id: lead!.id },
      data: {
        scoreReasons: [{ input: 'phonePresent', label: 'Phone on record', points: 15, maxPoints: 15 }],
        unknownInputs: [{ input: 'rating', label: 'Rating: not on record', reasonCode: 'RATING_MISSING' }],
      },
    });
    const batch = await h.db.importBatch.create({ data: { workspaceId: WS_A, source: 'META_ADS', externalBatchId: 'meta:page:lead-1', bodyHash: 'x', counts: {}, simulated: true } });
    await h.db.leadSourceRecord.create({
      data: {
        workspaceId: WS_A,
        leadId: lead!.id,
        importBatchId: batch.id,
        source: 'META_ADS',
        externalId: 'leadgen-1',
        status: 'ACCEPTED',
        rawPayloadRedacted: { field_data: '[redacted]' },
        attribution: { campaign: 'Diwali offer', form: 'Smile check', adId: 12 },
        receivedAt: h.clock.now(),
      },
    });
    const profile = await loadLeadProfile(await ownerCtx(h), lead!.id, deps);
    expect(profile.sources).toHaveLength(1);
    expect(profile.sources[0]).toMatchObject({
      source: 'META_ADS',
      status: 'ACCEPTED',
      externalId: 'leadgen-1',
      attribution: [
        { key: 'campaign', value: 'Diwali offer' },
        { key: 'form', value: 'Smile check' },
        { key: 'adId', value: '12' },
      ],
      batch: { externalBatchId: 'meta:page:lead-1', simulated: true },
    });
    expect(JSON.stringify(profile.sources)).not.toContain('field_data');
    expect(profile.score.reasons).toEqual([{ input: 'phonePresent', label: 'Phone on record', points: 15, maxPoints: 15 }]);
    expect(profile.score.unknownInputs).toEqual([{ input: 'rating', label: 'Rating: not on record', reasonCode: 'RATING_MISSING' }]);
  });

  it('another workspace is 404; leads.read only can read but not move stages', async () => {
    const [foreign] = await makeLeads(h.db, WS_B, [{ name: 'Profile Foreign' }]);
    await expect(loadLeadProfile(await ownerCtx(h), foreign!.id, deps)).rejects.toMatchObject({ status: 404 });
    const neha = await userCtx(h.db, h.clock, 'neha', 'ironpulse-fitness');
    const profile = await loadLeadProfile(neha, foreign!.id, deps);
    expect(profile.permissions.canMoveStage).toBe(false);
  });
});
