// M2 / ADR-14 (user decision D4), R27: email eligibility for leads without email opt-in (Maps
// leads in particular).
// - WhatsApp consent never implies email permission (NO_EMAIL_BASIS).
// - With the workspace setting on, an employee attestation (actor, time, note) allows a manual
//   single send only; bulk, automated and customer-requested replies are ATTESTED_MANUAL_ONLY.
// - With the setting off (the default), the attestation endpoint answers 403 and an existing
//   attestation no longer counts.
// - Email opt-in allows every intent; an email suppression blocks even an attested manual send.
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '@/lib/config';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { checkDispatchEligibility } from '@/server/services/messaging/eligibility';
import { grantManualConsent } from '@/server/services/messaging/consent';
import { recordSuppression } from '@/server/services/messaging/suppression';
import { POST as attestRoute } from '@/app/api/app/consent/attestations/route';
import { POST as grantRoute } from '@/app/api/app/consent/grants/route';
import { seedId } from '../../../prisma/seed/ids';
import { makeRequest, noParams, testConfig, uninstallRuntime, useRuntime } from '../auth/support';
import { userCtx } from '../quotes/support';
import { removeDir } from '../../support/db';
import { createConsentHarness, createLead, PEPPER, WS_A, wsCtx, type ConsentHarness } from './support';

const WS_A_SLUG = 'smile-avenue-dental';
let h: ConsentHarness;
let config: AppConfig;
let dataDir: string;

beforeAll(async () => {
  h = await createConsentHarness('email-eligibility');
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'auralead-consent-data-'));
  config = testConfig('demo', { SUPPRESSION_PEPPER: PEPPER, AURALEAD_DATA_DIR: dataDir });
  useRuntime(h.db, config, h.clock);
});
afterAll(async () => {
  uninstallRuntime();
  await h.cleanup();
  await removeDir(dataDir);
});

async function auth(userKey: string) {
  const user = await h.db.user.findUniqueOrThrow({ where: { id: seedId('user', userKey) } });
  const { token, session } = await createSession(h.db, { userId: user.id, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'consent', userAgent: 'vitest', now: h.clock.now() });
  return { cookie: `${sessionCookieName(config)}=${token}`, csrf: csrfTokenForSession(config, session.id) };
}

async function call(route: typeof attestRoute, url: string, userKey: string, body: Record<string, unknown>) {
  const a = await auth(userKey);
  const res = await route(makeRequest(url, { body, cookie: a.cookie, csrf: a.csrf }), noParams);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const attest = (userKey: string, body: Record<string, unknown>) => call(attestRoute, '/api/app/consent/attestations', userKey, body);

async function emailCheck(leadId: string, sendIntent: 'MANUAL_SINGLE' | 'BULK' | 'AUTOMATED' | 'CUSTOMER_REQUESTED_REPLY') {
  const ctx = wsCtx(h);
  return checkDispatchEligibility(ctx.db, ctx, { leadId, channel: 'EMAIL', kind: 'EMAIL', sendIntent }, h.deps);
}

async function setAttestation(enabled: boolean) {
  await h.db.workspaceSettings.update({ where: { workspaceId: WS_A }, data: { emailB2bAttestationEnabled: enabled, autoSendEnabled: true } });
}

describe('email eligibility (M2)', () => {
  let mapsLead: { id: string };

  beforeAll(async () => {
    mapsLead = await createLead(h.db, { source: 'GMAPS_EXTENSION', email: 'hello@sharma-sweets.example.in' });
  });

  it('the workspace default is opt-in only; WhatsApp consent never implies email', async () => {
    expect((await h.db.workspaceSettings.findUniqueOrThrow({ where: { workspaceId: WS_A } })).emailB2bAttestationEnabled).toBe(false);
    const owner = await userCtx(h.db, h.clock, 'owner');
    await grantManualConsent(
      owner,
      { leadId: mapsLead.id, channel: 'WHATSAPP', purpose: 'MARKETING', source: 'MANUAL_EVIDENCE', collectedAt: '2026-10-15T10:00:00.000Z', evidence: { note: 'Signed WhatsApp opt-in card at the shop', method: 'WRITTEN_FORM' }, noticeText: 'I agree to receive WhatsApp messages from Smile Avenue Dental Clinic about its services.' },
      h.deps,
    );
    for (const intent of ['MANUAL_SINGLE', 'BULK'] as const) {
      expect((await emailCheck(mapsLead.id, intent)).reasons).toEqual(['NO_EMAIL_BASIS']);
    }
    // Auto-send is off by default too, so an automated email is refused on both counts.
    expect((await emailCheck(mapsLead.id, 'AUTOMATED')).reasons).toEqual(['AUTO_SEND_DISABLED', 'NO_EMAIL_BASIS']);
  });

  it('with the setting off, the attestation endpoint answers 403 and writes nothing', async () => {
    const res = await attest('employee', { workspaceSlug: WS_A_SLUG, leadId: mapsLead.id, note: 'Listed business address, B2B services enquiry' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'ATTESTATION_DISABLED' });
    expect(await h.db.consentRecord.count({ where: { leadId: mapsLead.id, channel: 'EMAIL' } })).toBe(0);
  });

  it('with the setting on, an employee attests (actor, time, note): manual single ok; bulk, automated, customer reply ATTESTED_MANUAL_ONLY', async () => {
    await setAttestation(true);
    const res = await attest('employee', { workspaceSlug: WS_A_SLUG, leadId: mapsLead.id, note: 'Listed business address, B2B services enquiry' });
    expect(res.status).toBe(200);
    const consent = await h.db.consentRecord.findUniqueOrThrow({ where: { id: String((res.body as { consentId: string }).consentId) } });
    expect(consent).toMatchObject({ channel: 'EMAIL', purpose: 'MARKETING', basis: 'B2B_ATTESTED', source: 'EMPLOYEE_ATTESTATION', recordedBy: seedId('user', 'employee') });
    expect(consent.evidence).toEqual({ attestedBy: seedId('user', 'employee'), note: 'Listed business address, B2B services enquiry' });
    expect(consent.collectedAt.toISOString()).toBe(h.clock.now().toISOString());
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'consent.attest_b2b', targetId: consent.id } });
    expect(JSON.stringify(audit.summary)).not.toContain('sharma-sweets');

    const manual = await emailCheck(mapsLead.id, 'MANUAL_SINGLE');
    expect(manual).toMatchObject({ eligible: true, mode: 'email', reasons: [] });
    for (const intent of ['BULK', 'AUTOMATED', 'CUSTOMER_REQUESTED_REPLY'] as const) {
      expect((await emailCheck(mapsLead.id, intent)).reasons).toEqual(['ATTESTED_MANUAL_ONLY']);
    }
  });

  it('an email suppression blocks even the attested manual send', async () => {
    const lead = await createLead(h.db, { source: 'GMAPS_EXTENSION', email: 'owner@patel-hardware.example.in' });
    const res = await attest('employee', { workspaceSlug: WS_A_SLUG, leadId: lead.id, note: 'Hardware wholesaler, B2B enquiry' });
    expect(res.status).toBe(200);
    expect((await emailCheck(lead.id, 'MANUAL_SINGLE')).eligible).toBe(true);
    await recordSuppression(wsCtx(h), { channel: 'EMAIL', contact: { kind: 'email', value: 'owner@patel-hardware.example.in' }, reason: 'UNSUBSCRIBE' }, h.deps);
    expect((await emailCheck(lead.id, 'MANUAL_SINGLE')).reasons).toEqual(['SUPPRESSED']);
    // An attestation is not an opt-in: it never clears a suppression.
    const again = await attest('employee', { workspaceSlug: WS_A_SLUG, leadId: lead.id, note: 'Re-attesting after unsubscribe' });
    expect(again.status).toBe(200);
    expect((await emailCheck(lead.id, 'MANUAL_SINGLE')).reasons).toEqual(['SUPPRESSED']);
  });

  it('a lead without a valid email cannot be attested (422) and is EMAIL_INVALID', async () => {
    const lead = await createLead(h.db, { source: 'GMAPS_EXTENSION', email: null });
    const res = await attest('employee', { workspaceSlug: WS_A_SLUG, leadId: lead.id, note: 'Phone-only listing' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'NO_CONTACT_FOR_CHANNEL' });
    expect((await emailCheck(lead.id, 'MANUAL_SINGLE')).reasons).toEqual(['EMAIL_INVALID', 'NO_EMAIL_BASIS']);
  });

  it('turning the setting off again makes existing attestations stop counting', async () => {
    await setAttestation(false);
    expect((await emailCheck(mapsLead.id, 'MANUAL_SINGLE')).reasons).toEqual(['NO_EMAIL_BASIS']);
  });

  it('an email opt-in (manual grant with evidence) allows every intent', async () => {
    const res = await call(grantRoute, '/api/app/consent/grants', 'owner', {
      leadId: mapsLead.id,
      channel: 'EMAIL',
      purpose: 'MARKETING',
      source: 'MANUAL_EVIDENCE',
      collectedAt: '2026-10-16T05:00:00.000Z',
      evidence: { note: 'Ticked the newsletter box on the paper enquiry form', reference: 'form-2291' },
    });
    expect(res.status).toBe(200);
    for (const intent of ['MANUAL_SINGLE', 'BULK', 'AUTOMATED'] as const) {
      expect((await emailCheck(mapsLead.id, intent)).eligible).toBe(true);
    }
  });

  it('routes enforce capability (403) and tenancy (404)', async () => {
    // neha holds only leads.read in ironpulse-fitness.
    const ironpulseLead = await createLead(h.db, { workspaceId: seedId('workspace', 'ironpulse-fitness'), email: 'a@b.example.in' });
    const denied = await attest('neha', { workspaceSlug: 'ironpulse-fitness', leadId: ironpulseLead.id, note: 'Trying without permission' });
    expect(denied.status).toBe(403);
    // The owner of workspace A cannot touch a lead of another workspace.
    const foreign = await call(grantRoute, '/api/app/consent/grants', 'owner', {
      leadId: ironpulseLead.id,
      channel: 'EMAIL',
      purpose: 'MARKETING',
      source: 'MANUAL_EVIDENCE',
      collectedAt: '2026-10-16T05:00:00.000Z',
      evidence: { note: 'Foreign lead id in the body' },
    });
    expect(foreign.status).toBe(404);
    // Manual grants cannot cite a source that is not evidence (Maps listing, system sources).
    for (const source of ['GMAPS_EXTENSION', 'START_KEYWORD', 'INBOUND_MESSAGE', 'EMPLOYEE_ATTESTATION']) {
      const bad = await call(grantRoute, '/api/app/consent/grants', 'owner', {
        leadId: mapsLead.id,
        channel: 'WHATSAPP',
        purpose: 'MARKETING',
        source,
        collectedAt: '2026-10-16T05:00:00.000Z',
        evidence: { note: 'Not a valid evidence source' },
      });
      expect(bad.status).toBe(400);
    }
  });
});
