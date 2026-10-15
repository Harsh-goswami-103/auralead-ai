/**
 * R40 (T24) global outbound pause from the admin panel:
 *  - only a super admin may set it, and only with a password re-entry (or sign-in) within 15
 *    minutes: an older session gets 401 REAUTH_REQUIRED and nothing changes;
 *  - the pause is stored in SystemSetting with who, when and why, and audited crossWorkspace;
 *  - a send already past P2 (SENDING committed) when the pause lands completes;
 *  - nothing new passes preflight while paused (deferred GLOBAL_PAUSED, 0 provider calls), and the
 *    same send goes out after an operator resumes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { POST as pausePost } from '@/app/api/admin/system/outbound-pause/route';
import { setPauseHandler } from '@/server/testing/pause';
import { approveAndSendMessage, createMessageDraft } from '@/server/services/messaging/dispatch';
import { readOutboundPause } from '@/server/services/admin/outbound-pause';
import { approvedTemplate, createLead, DEPS, grantConsent } from '../dispatch/support';
import { createInboundHarness, type InboundHarness } from '../messaging/inbound-support';
import { ADMIN_ID, adminSession, callRoute, type AdminAuth } from './support';

let h: InboundHarness;
beforeAll(async () => {
  h = await createInboundHarness('global-pause');
}, 120_000);
afterAll(async () => h?.destroy());
afterEach(() => setPauseHandler('dispatch.p2', null));

const PATH = '/api/admin/system/outbound-pause';
const pause = (auth: AdminAuth | null, paused: boolean, reason = 'Investigating a provider quality warning') => callRoute(pausePost, PATH, auth, { body: { paused, reason } });

async function queuedSend() {
  const lead = await createLead(h.db);
  await grantConsent(h.db, lead, 'WHATSAPP');
  const owner = await h.owner();
  const template = await approvedTemplate(h.db);
  const draft = await createMessageDraft(owner, { leadId: lead.id, channel: 'WHATSAPP', kind: 'TEMPLATE', templateId: template.id, variables: { '1': 'Asha' } }, DEPS);
  return approveAndSendMessage(owner, { messageId: draft.messageId }, DEPS);
}

describe('global outbound pause', () => {
  it('requires a super admin with a fresh authentication', async () => {
    const owner = await adminSession(h, { userKey: 'owner' });
    expect((await pause(owner, true)).status).toBe(404);
    expect((await pause(null, true)).status).toBe(401);

    const stale = await adminSession(h, { createdAt: new Date(h.clock.now().getTime() - 20 * 60_000) });
    const res = await pause(stale, true);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('REAUTH_REQUIRED');
    expect(await h.db.systemSetting.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ outboundPaused: false });

    const reason = await pause(await adminSession(h), true, '');
    expect(reason.status).toBe(400);
  });

  it('a send past P2 completes; nothing new passes preflight; resume releases it', async () => {
    const inFlight = await queuedSend();
    const admin = await adminSession(h);
    let pausedDuringFlight: number | null = null;
    setPauseHandler('dispatch.p2', async () => {
      pausedDuringFlight = (await pause(admin, true)).status;
    });
    await h.drain();
    expect(pausedDuringFlight).toBe(200);
    expect(h.wa.calls.map((c) => c.request.attemptId)).toEqual([inFlight.attemptId]);
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: inFlight.attemptId } })).toMatchObject({ state: 'SENT' });
    setPauseHandler('dispatch.p2', null);

    const setting = await h.db.systemSetting.findUniqueOrThrow({ where: { id: 1 } });
    expect(setting).toMatchObject({ outboundPaused: true, outboundPausedBy: ADMIN_ID, outboundPauseReason: 'Investigating a provider quality warning' });
    expect(setting.outboundPausedAt).not.toBeNull();
    const state = await readOutboundPause(h.db, { lockFile: h.config.paths.outboundLockFile, envPaused: false });
    expect(state).toMatchObject({ paused: true, db: { paused: true }, lockFile: { present: false } });

    const blocked = await queuedSend();
    await h.drain();
    expect(h.wa.calls).toHaveLength(1);
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: blocked.attemptId } })).toMatchObject({ state: 'QUEUED' });
    const job = await h.db.job.findUniqueOrThrow({ where: { id: blocked.jobId } });
    expect(job.status).toBe('QUEUED');
    expect(job.lastErrorCode).toContain('GLOBAL_PAUSED');
    expect(job.runAt.getTime()).toBeGreaterThan(h.clock.now().getTime());

    const resumed = await pause(admin, false, 'Provider confirmed the quality rating is green');
    expect(resumed.status).toBe(200);
    expect(await h.db.systemSetting.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ outboundPaused: false });
    h.clock.advance(61_000);
    await h.drain();
    expect(h.wa.calls.map((c) => c.request.attemptId)).toEqual([inFlight.attemptId, blocked.attemptId]);

    const audits = await h.db.auditEvent.findMany({ where: { actorUserId: ADMIN_ID, action: { in: ['system.outbound_pause', 'system.outbound_resume'] } }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => a.action)).toEqual(['system.outbound_pause', 'system.outbound_resume']);
    for (const a of audits) {
      expect(a.crossWorkspace).toBe(true);
      expect(a.workspaceId).toBeNull();
      expect(a.reason).toBeTruthy();
    }
  });
});
