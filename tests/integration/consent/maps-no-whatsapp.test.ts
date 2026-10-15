// AT8 (consent part), R22, ADR-15, user decision D4: a Google Maps (extension) lead has no WhatsApp
// consent, whatever a mapping says, so in a LIVE workspace with a CONNECTED WhatsApp integration
// and an APPROVED template (a live template campaign), the shared eligibility function skips it
// with NO_WHATSAPP_OPT_IN for every send intent, and evaluating it creates no DispatchAttempt.
// Its email is not a basis either: email needs opt-in or an enabled employee attestation.
// Control: a Sheets lead with recorded opt-in in the same workspace is eligible.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDispatchEligibility } from '@/server/services/messaging/eligibility';
import { ingestBatch } from '@/server/services/leads/ingest';
import { DEPS } from '../ingest/support';
import { createConsentHarness, ensureWhatsApp, wsCtx, type ConsentHarness } from './support';

let h: ConsentHarness;
let liveWs: string;
let templateId: string;

beforeAll(async () => {
  h = await createConsentHarness('maps-no-whatsapp');
  const ws = await h.db.workspace.create({ data: { slug: 'live-campaign-co', name: 'Live Campaign Co', mode: 'LIVE', planLabel: 'Growth' } });
  await h.db.workspaceSettings.create({ data: { workspaceId: ws.id, maxDiscountBps: 1000, brandColor: '#0F766E', termsText: 'Terms', autoSendEnabled: true } });
  liveWs = ws.id;
  const wa = await ensureWhatsApp(h.db, liveWs, 'CONNECTED');
  templateId = wa.approved.id;
});
afterAll(async () => {
  await h.cleanup();
});

const liveCtx = () => wsCtx(h, liveWs, 'live');
const NOTICE = 'Send me offers on WhatsApp.';
const MAPPING = { version: 1, consent: { column: 'consent', truthyValues: ['yes'], channel: 'WHATSAPP' as const, purpose: 'MARKETING' as const, noticeText: NOTICE } };

describe('Maps leads in a live template campaign (AT8)', () => {
  it('are skipped NO_WHATSAPP_OPT_IN for every intent, with no DispatchAttempt', async () => {
    const result = await ingestBatch(
      liveCtx(),
      {
        source: 'GMAPS_EXTENSION',
        externalBatchId: 'maps-batch-1',
        // A mapping cannot give a Maps lead consent.
        mapping: MAPPING,
        records: [
          {
            externalId: 'place-1',
            providerId: 'ChIJ-sharma-sweets',
            fields: { name: 'Sharma Sweets', phone: '+91 98450 70001', email: 'orders@sharma-sweets.example.in', category: 'Sweet shop', city: 'Jaipur' },
            answers: { consent: 'yes' },
            submittedAt: '2026-10-15T08:00:00.000Z',
          },
        ],
      },
      DEPS,
    );
    const rec = result.records[0]!;
    expect(rec.status).toBe('ACCEPTED');
    expect(rec.consent).toEqual({ outcome: 'NONE', reason: 'SOURCE_NOT_ELIGIBLE' });
    expect(await h.db.consentRecord.count({ where: { leadId: rec.leadId! } })).toBe(0);

    for (const sendIntent of ['BULK', 'AUTOMATED', 'MANUAL_SINGLE'] as const) {
      const ctx = liveCtx();
      const r = await checkDispatchEligibility(ctx.db, ctx, { leadId: rec.leadId!, channel: 'WHATSAPP', kind: 'WA_TEMPLATE', sendIntent, templateId }, h.deps);
      expect(r).toMatchObject({ eligible: false, deferrable: false, mode: 'none', reasons: ['NO_WHATSAPP_OPT_IN'] });
    }
    const ctx = liveCtx();
    const email = await checkDispatchEligibility(ctx.db, ctx, { leadId: rec.leadId!, channel: 'EMAIL', kind: 'EMAIL', sendIntent: 'MANUAL_SINGLE' }, h.deps);
    // LIVE with no email integration: also NOT_CONFIGURED, after the missing basis.
    expect(email.reasons).toEqual(['NO_EMAIL_BASIS', 'NOT_CONFIGURED']);

    expect(await h.db.dispatchAttempt.count({ where: { workspaceId: liveWs } })).toBe(0);
    expect(await h.db.message.count({ where: { workspaceId: liveWs } })).toBe(0);
  });

  it('control: a Sheets lead with recorded opt-in in the same live workspace is eligible', async () => {
    const result = await ingestBatch(
      liveCtx(),
      {
        source: 'GOOGLE_SHEETS',
        externalBatchId: 'sheet-run-1',
        mapping: MAPPING,
        records: [{ externalId: 'row-1', fields: { name: 'Gupta Opticals', phone: '+91 98450 70002' }, answers: { consent: 'yes' }, submittedAt: '2026-10-15T08:00:00.000Z' }],
      },
      DEPS,
    );
    const ctx = liveCtx();
    const r = await checkDispatchEligibility(ctx.db, ctx, { leadId: result.records[0]!.leadId!, channel: 'WHATSAPP', kind: 'WA_TEMPLATE', sendIntent: 'BULK', templateId }, h.deps);
    expect(r).toMatchObject({ eligible: true, mode: 'template', reasons: [] });
  });

  it('LIVE without a CONNECTED integration is NOT_CONFIGURED, never a demo transport', async () => {
    await h.db.integration.updateMany({ where: { workspaceId: liveWs, kind: 'WHATSAPP_CLOUD' }, data: { status: 'ERROR' } });
    const lead = await h.db.lead.findFirstOrThrow({ where: { workspaceId: liveWs, displayName: 'Gupta Opticals' } });
    const ctx = liveCtx();
    const r = await checkDispatchEligibility(ctx.db, ctx, { leadId: lead.id, channel: 'WHATSAPP', kind: 'WA_TEMPLATE', sendIntent: 'BULK', templateId }, h.deps);
    expect(r.reasons).toEqual(['NOT_CONFIGURED']);
  });
});
