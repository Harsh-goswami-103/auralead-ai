// ADR-125 (lead-gen F5): the reach-out panel. A Places or plain-import lead has no WhatsApp opt-in,
// so an operator either records one the customer gave (with the notice they agreed to, which must
// name the business, and how it was obtained) or shares the business's click-to-chat link, where
// the customer writes first.
// - Recording a WhatsApp MARKETING opt-in without `evidence.method` (422 EVIDENCE_METHOD_REQUIRED),
//   without the notice (422 NOTICE_REQUIRED) or with a notice that does not name the business
//   (422 NOTICE_MISSING_BUSINESS_NAME) writes nothing. A valid one keeps the notice verbatim with
//   its hash and the method, marks the contact confirmed (RECORDED_OPT_IN) and audits no text.
// - The workspace notice and privacy contact (automation.manage; an owner holds it, a member does
//   not); the default notice names the business, STOP and the privacy contact.
// - Click-to-chat: wa.me/<display number digits>?text=<prefill>; a prefill that folds to a START or
//   STOP keyword is refused (422 PREFILL_IS_KEYWORD); no display number is 422.
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as grantRoute } from '@/app/api/app/consent/grants/route';
import { POST as clickToChatRoute } from '@/app/api/app/settings/reach-out/click-to-chat/route';
import { POST as settingsRoute } from '@/app/api/app/settings/reach-out/route';
import type { AppConfig } from '@/lib/config';
import { defaultOptInNotice } from '@/lib/schemas/reach-out';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { grantManualConsent, noticeTextHash } from '@/server/services/messaging/consent';
import { buildClickToChat, isKeywordPrefill, loadReachOut, updateReachOutSettings } from '@/server/services/leads/reach-out';
import { seedId } from '../../../prisma/seed/ids';
import { makeRequest, noParams, testConfig, uninstallRuntime, useRuntime } from '../auth/support';
import { createConsentHarness, createLead, PEPPER, WS_A, type ConsentHarness } from '../consent/support';
import { removeDir } from '../../support/db';
import { userCtx } from '../quotes/support';

const BUSINESS = 'Smile Avenue Dental Clinic';
const NOTICE = `I agree to receive WhatsApp messages from ${BUSINESS} about its treatments. Reply STOP to stop.`;
const WS_A_SLUG = 'smile-avenue-dental';

let h: ConsentHarness;
let config: AppConfig;
let dataDir: string;

beforeAll(async () => {
  h = await createConsentHarness('reach-out');
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'auralead-reach-out-data-'));
  config = testConfig('demo', { SUPPRESSION_PEPPER: PEPPER, AURALEAD_DATA_DIR: dataDir });
  useRuntime(h.db, config, h.clock);
}, 120_000);
afterAll(async () => {
  uninstallRuntime();
  await h.cleanup();
  await removeDir(dataDir);
});

async function auth(userKey: string) {
  const user = await h.db.user.findUniqueOrThrow({ where: { id: seedId('user', userKey) } });
  const { token, session } = await createSession(h.db, { userId: user.id, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'reach', userAgent: 'vitest', now: h.clock.now() });
  return { cookie: `${sessionCookieName(config)}=${token}`, csrf: csrfTokenForSession(config, session.id) };
}

async function call(route: typeof grantRoute, url: string, userKey: string, body: Record<string, unknown>) {
  const a = await auth(userKey);
  const res = await route(makeRequest(url, { body, cookie: a.cookie, csrf: a.csrf }), noParams);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const optIn = (leadId: string, over: Record<string, unknown> = {}) => ({
  leadId,
  channel: 'WHATSAPP',
  purpose: 'MARKETING',
  source: 'MANUAL_EVIDENCE',
  collectedAt: '2026-10-15T10:00:00.000Z',
  evidence: { note: 'Said yes when we called about the website', method: 'CALL_VERBAL' },
  noticeText: NOTICE,
  ...over,
});

describe('recording a WhatsApp opt-in', () => {
  it('needs the method and a notice that names the business; a refused one writes nothing', async () => {
    const lead = await createLead(h.db, { source: 'GMAPS_EXTENSION' });
    const owner = await userCtx(h.db, h.clock, 'owner');
    const grantsBefore = await h.db.auditEvent.count({ where: { action: 'consent.grant' } });
    const refused: Array<[Record<string, unknown>, string]> = [
      [{ evidence: { note: 'Said yes when we called' } }, 'EVIDENCE_METHOD_REQUIRED'],
      [{ noticeText: undefined }, 'NOTICE_REQUIRED'],
      [{ noticeText: 'I agree to receive WhatsApp messages about website offers.' }, 'NOTICE_MISSING_BUSINESS_NAME'],
    ];
    for (const [over, code] of refused) {
      await expect(grantManualConsent(owner, optIn(lead.id, over), h.deps), code).rejects.toMatchObject({ status: 422, code });
    }
    expect(await h.db.consentRecord.count({ where: { leadId: lead.id } })).toBe(0);
    expect(await h.db.auditEvent.count({ where: { action: 'consent.grant' } })).toBe(grantsBefore);
    expect(await h.db.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ contactConfirmedAt: null, contactConfirmedVia: null });

    // Through the route (the operator's console names the workspace by slug): the same 422.
    const viaRoute = await call(grantRoute, '/api/app/consent/grants', 'employee', { ...optIn(lead.id, { noticeText: 'Yes to WhatsApp updates.' }), workspaceSlug: WS_A_SLUG });
    expect(viaRoute).toMatchObject({ status: 422, body: { code: 'NOTICE_MISSING_BUSINESS_NAME' } });
  });

  it('a valid one keeps the notice and its hash and the method, confirms the contact and audits no text', async () => {
    const lead = await createLead(h.db, { source: 'GMAPS_EXTENSION' });
    // Case, width and spacing do not matter for the business name.
    const notice = 'Yes, I agree to WhatsApp messages from SMILE   avenue dental clinic. Reply STOP to stop.';
    const res = await call(grantRoute, '/api/app/consent/grants', 'employee', { ...optIn(lead.id, { noticeText: notice, evidence: { note: 'Signed the form at the clinic', method: 'WRITTEN_FORM', reference: 'form-12' } }), workspaceSlug: WS_A_SLUG });
    expect(res.status).toBe(200);
    const record = await h.db.consentRecord.findUniqueOrThrow({ where: { id: String(res.body.consentId) } });
    expect(record).toMatchObject({ basis: 'OPT_IN', channel: 'WHATSAPP', purpose: 'MARKETING', source: 'MANUAL_EVIDENCE', noticeTextHash: noticeTextHash(notice), recordedBy: seedId('user', 'employee') });
    expect(record.evidence).toEqual({ note: 'Signed the form at the clinic', reference: 'form-12', method: 'WRITTEN_FORM', noticeText: notice });
    expect(await h.db.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ contactConfirmedAt: h.clock.now(), contactConfirmedVia: 'RECORDED_OPT_IN' });
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'consent.grant', targetId: record.id } });
    expect(audit.summary).toMatchObject({ channel: 'WHATSAPP', purpose: 'MARKETING', method: 'WRITTEN_FORM', fields: ['evidence.note', 'evidence.method', 'noticeText'] });
    expect(JSON.stringify(audit.summary)).not.toMatch(/clinic\. Reply|Signed the form/);
  });

  it('an earlier confirmation is kept; an email opt-in still needs neither notice nor method', async () => {
    const lead = await createLead(h.db, { email: 'owner@clinic.example' });
    const earlier = new Date('2026-10-01T00:00:00.000Z');
    await h.db.lead.update({ where: { id: lead.id }, data: { contactConfirmedAt: earlier, contactConfirmedVia: 'INBOUND_WHATSAPP' } });
    const owner = await userCtx(h.db, h.clock, 'owner');
    await grantManualConsent(owner, optIn(lead.id), h.deps);
    expect(await h.db.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ contactConfirmedAt: earlier, contactConfirmedVia: 'INBOUND_WHATSAPP' });
    const email = await grantManualConsent(owner, { leadId: lead.id, channel: 'EMAIL', purpose: 'MARKETING', source: 'MANUAL_EVIDENCE', collectedAt: '2026-10-15T10:00:00.000Z', evidence: { note: 'Asked for the newsletter' } }, h.deps);
    expect(await h.db.consentRecord.findUniqueOrThrow({ where: { id: email.consentId } })).toMatchObject({ channel: 'EMAIL', noticeTextHash: null });
  });
});

describe('the workspace notice and privacy contact', () => {
  it('the default notice names the business, STOP and the privacy contact; the owner sets the workspace own', async () => {
    const owner = await userCtx(h.db, h.clock, 'owner');
    const before = await loadReachOut(owner);
    expect(before).toMatchObject({ noticeIsDefault: true, noticePrefill: defaultOptInNotice(BUSINESS, null), settings: { whatsappOptInNotice: null, privacyContact: null } });
    expect(before.noticePrefill).toContain(BUSINESS);
    expect(before.noticePrefill).toContain('STOP');
    expect(before.permissions).toEqual({ canRecordOptIn: true, canManageSettings: true });

    const saved = await updateReachOutSettings(owner, { whatsappOptInNotice: `  ${NOTICE}  `, privacyContact: 'privacy@smileavenue.example' });
    expect(saved).toEqual({ whatsappOptInNotice: NOTICE, privacyContact: 'privacy@smileavenue.example', changed: ['whatsappOptInNotice', 'privacyContact'] });
    expect(await loadReachOut(owner)).toMatchObject({ noticeIsDefault: false, noticePrefill: NOTICE });
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'workspace.reach_out', workspaceId: WS_A }, orderBy: { createdAt: 'desc' } });
    expect(audit.summary).toEqual({ fields: ['whatsappOptInNotice', 'privacyContact'] });
    // Unchanged values change nothing and write no audit row.
    expect((await updateReachOutSettings(owner, { whatsappOptInNotice: NOTICE, privacyContact: 'privacy@smileavenue.example' })).changed).toEqual([]);
    expect(await h.db.auditEvent.count({ where: { action: 'workspace.reach_out', workspaceId: WS_A } })).toBe(1);

    // Clearing the notice brings the default back, now with the privacy contact.
    await updateReachOutSettings(owner, { whatsappOptInNotice: '', privacyContact: 'privacy@smileavenue.example' });
    expect((await loadReachOut(owner)).noticePrefill).toBe(defaultOptInNotice(BUSINESS, 'privacy@smileavenue.example'));
    expect((await loadReachOut(owner)).noticePrefill).toContain('privacy@smileavenue.example');
  });

  it('a notice without the business name is 422; a member is 403; an operator with automation.manage saves by slug', async () => {
    const owner = await userCtx(h.db, h.clock, 'owner');
    await expect(updateReachOutSettings(owner, { whatsappOptInNotice: 'I agree to WhatsApp messages.', privacyContact: null })).rejects.toMatchObject({ status: 422, code: 'NOTICE_MISSING_BUSINESS_NAME' });
    const member = await userCtx(h.db, h.clock, 'pooja');
    await expect(updateReachOutSettings(member, { whatsappOptInNotice: null, privacyContact: 'help@kesari.example' })).rejects.toMatchObject({ status: 403 });
    expect((await loadReachOut(member)).permissions).toEqual({ canRecordOptIn: true, canManageSettings: false });

    const res = await call(settingsRoute, '/api/app/settings/reach-out', 'employee', { workspaceSlug: WS_A_SLUG, whatsappOptInNotice: NOTICE, privacyContact: 'dpo@smileavenue.example' });
    expect(res).toMatchObject({ status: 200, body: { whatsappOptInNotice: NOTICE, privacyContact: 'dpo@smileavenue.example' } });
    expect(await h.db.workspaceSettings.findUniqueOrThrow({ where: { workspaceId: WS_A } })).toMatchObject({ whatsappOptInNotice: NOTICE, privacyContact: 'dpo@smileavenue.example', updatedBy: seedId('user', 'employee') });
  });
});

describe('click-to-chat', () => {
  it('folds the prefill like inbound messages: START and STOP keywords in any case or script are refused', () => {
    for (const keyword of ['STOP', ' stop. ', 'Stop!', 'unsubscribe', 'opt-out', 'START', 'subscribe', 'बंद करें', 'शुरू']) expect(isKeywordPrefill(keyword), keyword).toBe(true);
    for (const text of ['Hi, I would like to know more', 'Please do not stop the offers', 'start my website project']) expect(isKeywordPrefill(text), text).toBe(false);
  });

  it('builds wa.me/<digits>?text=<prefill> from the WhatsApp display number; keyword prefills and a missing number are 422', async () => {
    const owner = await userCtx(h.db, h.clock, 'owner');
    expect((await loadReachOut(owner)).clickToChat).toEqual({ available: false, reason: 'NOT_CONFIGURED' });
    await expect(buildClickToChat(owner, { prefill: 'Hello' })).rejects.toMatchObject({ status: 422, code: 'CLICK_TO_CHAT_NOT_CONFIGURED' });

    const integration = await h.db.integration.create({ data: { workspaceId: WS_A, kind: 'WHATSAPP_CLOUD', status: 'SIMULATED', config: { phoneNumberId: '1098765' } } });
    expect((await loadReachOut(owner)).clickToChat).toEqual({ available: false, reason: 'NO_DISPLAY_NUMBER' });
    await h.db.integration.update({ where: { id: integration.id }, data: { config: { phoneNumberId: '1098765', displayPhoneNumber: '+919812345678' } } });

    const view = await loadReachOut(owner);
    expect(view.clickToChat).toEqual({
      available: true,
      displayPhoneNumber: '+919812345678',
      prefill: `Hi ${BUSINESS}, I would like to know more about your services.`,
      link: `https://wa.me/919812345678?text=${encodeURIComponent(`Hi ${BUSINESS}, I would like to know more about your services.`)}`,
      simulated: true,
    });
    expect(await buildClickToChat(owner, { prefill: 'Hi! I saw your card & want a website?' })).toEqual({
      link: 'https://wa.me/919812345678?text=Hi!%20I%20saw%20your%20card%20%26%20want%20a%20website%3F',
      prefill: 'Hi! I saw your card & want a website?',
      displayPhoneNumber: '+919812345678',
    });
    await expect(buildClickToChat(owner, { prefill: 'Stop' })).rejects.toMatchObject({ status: 422, code: 'PREFILL_IS_KEYWORD' });

    const viaRoute = await call(clickToChatRoute, '/api/app/settings/reach-out/click-to-chat', 'employee', { workspaceSlug: WS_A_SLUG, prefill: 'subscribe' });
    expect(viaRoute).toMatchObject({ status: 422, body: { code: 'PREFILL_IS_KEYWORD' } });
    const ok = await call(clickToChatRoute, '/api/app/settings/reach-out/click-to-chat', 'employee', { workspaceSlug: WS_A_SLUG, prefill: 'Hello from your website' });
    expect(ok).toMatchObject({ status: 200, body: { link: 'https://wa.me/919812345678?text=Hello%20from%20your%20website' } });

    // A revoked integration has no usable number.
    await h.db.integration.update({ where: { id: integration.id }, data: { status: 'REVOKED' } });
    expect((await loadReachOut(owner)).clickToChat).toEqual({ available: false, reason: 'NOT_CONFIGURED' });
  });
});
