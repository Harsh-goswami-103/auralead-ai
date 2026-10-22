// T26, R4 (plan §11 M4): a manual sales-stage move is a compare-and-set on Lead.stageVersion. A
// person who moves a lead with the version they saw wins once; a stale version (another person's
// move, or an automatic promotion since) answers 409 STAGE_VERSION_CONFLICT and changes nothing.
// Automatic promotions only move a lead forward (a LOST or CONVERTED lead is never pulled back to
// QUOTE_SENT) and bump the version, so an open Kanban board cannot overwrite them blindly. Moving
// to LOST needs a reason and is audited with it. Stage moves never touch consent, suppression or
// delivery state. The route answers 409 for a stale version, 403 without leads.write and 404 for
// another workspace's lead.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as stageRoute } from '@/app/api/app/leads/[leadId]/stage/route';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { moveLeadStage } from '@/server/services/leads/stage';
import { markQuoteSentManually } from '@/server/services/quotes/manual-send';
import { approveQuote, createQuote } from '@/server/services/quotes/versioning';
import type { AppConfig } from '@/lib/config';
import { seedId } from '../../../prisma/seed/ids';
import { makeRequest } from '../auth/support';
import { acceptFormFields, createPublicHarness, getQuotePage, issueQuote, postAccept, type PublicHarness } from '../quotes/public-support';
import { SERVICE } from '../quotes/support';
import { makeLeads, ownerCtx, userCtx, WS_A, WS_B, WS_KESARI } from './support';

let h: PublicHarness;
let config: AppConfig;

beforeAll(async () => {
  h = await createPublicHarness('stage-cas');
  config = h.runtime.config;
}, 120_000);

afterAll(async () => {
  await h?.destroy();
});

const lead = (id: string) => h.db.lead.findUniqueOrThrow({ where: { id } });
const stageAudits = (id: string) => h.db.auditEvent.findMany({ where: { targetType: 'Lead', targetId: id, action: 'lead.stage' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

describe('manual stage moves (compare-and-set)', () => {
  it('a move with the current version wins once; the same version again is 409 and changes nothing', async () => {
    const owner = await ownerCtx(h);
    const [l] = await makeLeads(h.db, WS_A, [{ name: 'Stage Cas One' }]);
    const moved = await moveLeadStage(owner, { leadId: l!.id, toStage: 'CONTACTED', expectedStageVersion: 0 });
    expect(moved).toEqual({ changed: true, lead: { id: l!.id, salesStage: 'CONTACTED', stageVersion: 1 } });

    await expect(moveLeadStage(owner, { leadId: l!.id, toStage: 'REPLIED', expectedStageVersion: 0 })).rejects.toMatchObject({
      status: 409,
      code: 'STAGE_VERSION_CONFLICT',
      safeDetails: { currentStageVersion: 1, currentStage: 'CONTACTED' },
    });
    expect(await lead(l!.id)).toMatchObject({ salesStage: 'CONTACTED', stageVersion: 1 });

    const audits = await stageAudits(l!.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorKind: 'USER', result: 'SUCCESS', workspaceId: WS_A, actorUserId: seedId('user', 'owner') });
    expect(audits[0]!.summary).toMatchObject({ from: 'NEW', to: 'CONTACTED', stageVersion: 1, manual: true });
  });

  it('two people moving the same card at once: exactly one wins, the other gets 409', async () => {
    const [l] = await makeLeads(h.db, WS_A, [{ name: 'Stage Cas Race' }]);
    const a = await ownerCtx(h);
    const b = await userCtx(h.db, h.clock, 'employee', 'smile-avenue-dental');
    const results = await Promise.allSettled([
      moveLeadStage(a, { leadId: l!.id, toStage: 'CONTACTED', expectedStageVersion: 0 }),
      moveLeadStage(b, { leadId: l!.id, toStage: 'LOST', expectedStageVersion: 0, reason: 'Chose a competitor' }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toMatchObject({ status: 409, code: 'STAGE_VERSION_CONFLICT' });
    expect((await lead(l!.id)).stageVersion).toBe(1);
    expect(await stageAudits(l!.id)).toHaveLength(1);
  });

  it('moving to the stage the lead is already in is a no-op without an audit row', async () => {
    const owner = await ownerCtx(h);
    const [l] = await makeLeads(h.db, WS_A, [{ name: 'Stage Cas Same', stage: 'REPLIED' }]);
    expect(await moveLeadStage(owner, { leadId: l!.id, toStage: 'REPLIED', expectedStageVersion: 0 })).toEqual({
      changed: false,
      lead: { id: l!.id, salesStage: 'REPLIED', stageVersion: 0 },
    });
    expect(await stageAudits(l!.id)).toHaveLength(0);
  });

  it('LOST needs a reason, is audited with it, and a person can reopen the lead later', async () => {
    const owner = await ownerCtx(h);
    const [l] = await makeLeads(h.db, WS_A, [{ name: 'Stage Cas Lost', stage: 'QUOTE_SENT' }]);
    await expect(moveLeadStage(owner, { leadId: l!.id, toStage: 'LOST', expectedStageVersion: 0 })).rejects.toMatchObject({ status: 422, code: 'LOST_REASON_REQUIRED' });
    await expect(moveLeadStage(owner, { leadId: l!.id, toStage: 'LOST', expectedStageVersion: 0, reason: ' x ' })).rejects.toMatchObject({ status: 422, code: 'LOST_REASON_REQUIRED' });
    expect((await lead(l!.id)).salesStage).toBe('QUOTE_SENT');

    await moveLeadStage(owner, { leadId: l!.id, toStage: 'LOST', expectedStageVersion: 0, reason: 'Budget went to a bigger clinic' });
    const reopened = await moveLeadStage(owner, { leadId: l!.id, toStage: 'CONTACTED', expectedStageVersion: 1 });
    expect(reopened.lead).toMatchObject({ salesStage: 'CONTACTED', stageVersion: 2 });

    // Both rows carry the same (fixed) clock time, so they are matched by content, not order.
    const audits = await stageAudits(l!.id);
    expect(audits).toHaveLength(2);
    const lostAudit = audits.find((a) => (a.summary as { to?: string }).to === 'LOST')!;
    const reopenAudit = audits.find((a) => (a.summary as { to?: string }).to === 'CONTACTED')!;
    expect(lostAudit.summary).toMatchObject({ from: 'QUOTE_SENT', to: 'LOST', stageVersion: 1, manual: true });
    expect(lostAudit.reason).toBe('Budget went to a bigger clinic');
    expect(reopenAudit.summary).toMatchObject({ from: 'LOST', to: 'CONTACTED', stageVersion: 2, manual: true });
    expect(reopenAudit.reason).toBeNull();
  });

  it('needs leads.write; another workspace or a merged lead is refused', async () => {
    const neha = await userCtx(h.db, h.clock, 'neha', 'ironpulse-fitness');
    const [b] = await makeLeads(h.db, WS_B, [{ name: 'Stage Cas Foreign' }]);
    await expect(moveLeadStage(neha, { leadId: b!.id, toStage: 'CONTACTED', expectedStageVersion: 0 })).rejects.toMatchObject({ status: 403 });
    const owner = await ownerCtx(h);
    await expect(moveLeadStage(owner, { leadId: b!.id, toStage: 'CONTACTED', expectedStageVersion: 0 })).rejects.toMatchObject({ status: 404 });
    const [target] = await makeLeads(h.db, WS_A, [{ name: 'Stage Cas Target' }]);
    const [merged] = await makeLeads(h.db, WS_A, [{ name: 'Stage Cas Merged', mergedInto: target!.id }]);
    await expect(moveLeadStage(owner, { leadId: merged!.id, toStage: 'CONTACTED', expectedStageVersion: 0 })).rejects.toMatchObject({ status: 422, code: 'LEAD_MERGED' });
    expect((await lead(b!.id)).stageVersion).toBe(0);
  });

  it('never changes consent, suppression or delivery state (R4)', async () => {
    const owner = await ownerCtx(h);
    const [l] = await makeLeads(h.db, WS_A, [{ name: 'Stage Cas Consent', email: 'consent.case@example.test' }]);
    await h.db.consentRecord.create({
      data: { workspaceId: WS_A, leadId: l!.id, contactKey: 'ck-stage-cas', channel: 'WHATSAPP', purpose: 'MARKETING', basis: 'OPT_IN', source: 'MANUAL_EVIDENCE', evidence: {}, collectedAt: h.clock.now(), recordedAt: h.clock.now() },
    });
    const snapshot = async () => ({
      consents: await h.db.consentRecord.findMany({ where: { leadId: l!.id } }),
      suppressions: await h.db.suppression.count({ where: { workspaceId: WS_A } }),
      attempts: await h.db.dispatchAttempt.count({ where: { workspaceId: WS_A } }),
      messages: await h.db.message.count({ where: { workspaceId: WS_A } }),
      jobs: await h.db.job.count(),
    });
    const before = await snapshot();
    await moveLeadStage(owner, { leadId: l!.id, toStage: 'LOST', expectedStageVersion: 0, reason: 'Not interested' });
    await moveLeadStage(owner, { leadId: l!.id, toStage: 'CONVERTED', expectedStageVersion: 1 });
    expect(await snapshot()).toEqual(before);
  });
});

describe('automatic promotions are forward-only and bump the version', () => {
  async function approvedQuoteFor(leadId: string) {
    const owner = await ownerCtx(h);
    const { quote } = await createQuote(owner, { leadId, items: [{ serviceId: SERVICE.CONSULT, qty: 1 }], discount: { kind: 'NONE', value: 0n }, scopeText: 'Scope', timelineText: 'One week' });
    await approveQuote(owner, quote.id, { expectedVersion: 1 });
    return { owner, quote };
  }

  it('a quote marked sent moves NEW forward to QUOTE_SENT; the board holding version 0 then gets 409', async () => {
    const [l] = await makeLeads(h.db, WS_A, [{ name: 'Promote Forward' }]);
    const { owner, quote } = await approvedQuoteFor(l!.id);
    await markQuoteSentManually(owner, quote.id, { expectedVersion: 1, via: 'MARK_SENT' });
    expect(await lead(l!.id)).toMatchObject({ salesStage: 'QUOTE_SENT', stageVersion: 1 });
    await expect(moveLeadStage(owner, { leadId: l!.id, toStage: 'CONTACTED', expectedStageVersion: 0 })).rejects.toMatchObject({ status: 409 });
  });

  it('a quote marked sent leaves a LOST or CONVERTED lead where a person put it', async () => {
    for (const stage of ['LOST', 'CONVERTED'] as const) {
      const [l] = await makeLeads(h.db, WS_A, [{ name: `Promote Stays ${stage}`, stage }]);
      const { owner, quote } = await approvedQuoteFor(l!.id);
      await markQuoteSentManually(owner, quote.id, { expectedVersion: 1, via: 'MARK_SENT' });
      expect(await lead(l!.id)).toMatchObject({ salesStage: stage, stageVersion: 0 });
    }
  });

  it('an accepted quote converts the lead and bumps the version, so a stale move is 409', async () => {
    const q = await issueQuote(h, { sent: true, leadName: 'Promote Accepted' });
    const page = await getQuotePage(q.token, { ip: '192.0.2.200' });
    const form = acceptFormFields(await page.text());
    const res = await postAccept(q.token, { body: { token: q.token, ...form, acceptorName: 'Asha Raman' }, ip: '192.0.2.201' });
    expect(res.status).toBe(200);
    expect(await lead(q.leadId)).toMatchObject({ salesStage: 'CONVERTED', stageVersion: 1 });
    const owner = await ownerCtx(h);
    await expect(moveLeadStage(owner, { leadId: q.leadId, toStage: 'LOST', expectedStageVersion: 0, reason: 'Stale board' })).rejects.toMatchObject({ status: 409 });
  });
});

describe('POST /api/app/leads/[leadId]/stage', () => {
  async function auth(key: string) {
    const user = await h.db.user.findUniqueOrThrow({ where: { id: seedId('user', key) } });
    const { token, session } = await createSession(h.db, { userId: user.id, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'stage', userAgent: 'vitest', now: h.clock.now() });
    return { cookie: `${sessionCookieName(config)}=${token}`, csrf: csrfTokenForSession(config, session.id) };
  }
  const post = async (key: string, leadId: string, body: Record<string, unknown>) => {
    const a = await auth(key);
    return stageRoute(makeRequest(`/api/app/leads/${leadId}/stage`, { body, cookie: a.cookie, csrf: a.csrf }), { params: Promise.resolve({ leadId }) });
  };

  it('200 with the new version, then 409 for the stale one', async () => {
    const [l] = await makeLeads(h.db, WS_A, [{ name: 'Route Stage' }]);
    const ok = await post('owner', l!.id, { toStage: 'CONTACTED', expectedStageVersion: 0 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ changed: true, lead: { id: l!.id, salesStage: 'CONTACTED', stageVersion: 1 } });
    const stale = await post('owner', l!.id, { toStage: 'REPLIED', expectedStageVersion: 0 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'STAGE_VERSION_CONFLICT' });
  });

  it('an employee moves a lead of an assigned workspace by slug; leads.read only is 403; a foreign lead is 404', async () => {
    const [a] = await makeLeads(h.db, WS_A, [{ name: 'Route Stage Employee' }]);
    const res = await post('employee', a!.id, { workspaceSlug: 'smile-avenue-dental', toStage: 'REPLIED', expectedStageVersion: 0 });
    expect(res.status).toBe(200);
    const [b] = await makeLeads(h.db, WS_B, [{ name: 'Route Stage Neha' }]);
    expect((await post('neha', b!.id, { workspaceSlug: 'ironpulse-fitness', toStage: 'REPLIED', expectedStageVersion: 0 })).status).toBe(403);
    const [k] = await makeLeads(h.db, WS_KESARI, [{ name: 'Route Stage Kesari' }]);
    expect((await post('owner', k!.id, { toStage: 'REPLIED', expectedStageVersion: 0 })).status).toBe(404);
    expect((await post('employee', k!.id, { workspaceSlug: 'smile-avenue-dental', toStage: 'REPLIED', expectedStageVersion: 0 })).status).toBe(404);
  });
});

