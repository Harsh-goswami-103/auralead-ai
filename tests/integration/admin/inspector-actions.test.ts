/**
 * R33 (T24) inspector actions, through the real admin routes:
 *  - an AMBIGUOUS attempt is never retried blindly: the job retry answers 409 until an operator
 *    resolves the attempt; "Verified not delivered, requeue" needs a typed reason and the confirm
 *    text, creates attempt N+1 on a new job and the worker runs the full preflight again;
 *  - a lead suppressed before or after the requeue gets no send (cancelled in the Stop
 *    transaction, or skipped SUPPRESSED by preflight), 0 provider calls;
 *  - "Mark delivered" closes the attempt as SENT with the operator as resolver;
 *  - cancel of a QUEUED dispatch job cancels its attempt and message; a terminal job answers 409;
 *  - a DEAD job of a type without provider side effects is requeued; a dispatch job whose
 *    retries ran out gets attempt N+1 on a new job;
 *  - only a super admin with a fresh authentication may act; every action is audited with
 *    crossWorkspace and the operator's reason.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as cancelPost } from '@/app/api/admin/jobs/[jobId]/cancel/route';
import { POST as resolvePost } from '@/app/api/admin/jobs/[jobId]/resolve/route';
import { POST as retryPost } from '@/app/api/admin/jobs/[jobId]/retry/route';
import { approveAndSendMessage, createMessageDraft } from '@/server/services/messaging/dispatch';
import { ambiguous, approvedTemplate, attemptsOf, createLead, DEPS, grantConsent, rateLimited } from '../dispatch/support';
import { advanceAndDrain, createInboundHarness, inbound, WS_A, type InboundHarness } from '../messaging/inbound-support';
import { ADMIN_ID, adminSession, callRoute, type AdminAuth } from './support';

let h: InboundHarness;
let admin: AdminAuth;

beforeAll(async () => {
  h = await createInboundHarness('inspector-actions');
  admin = await adminSession(h);
}, 120_000);
afterAll(async () => h?.destroy());

async function queuedTemplateSend() {
  const lead = await createLead(h.db);
  await grantConsent(h.db, lead, 'WHATSAPP');
  const owner = await h.owner();
  const template = await approvedTemplate(h.db);
  const draft = await createMessageDraft(owner, { leadId: lead.id, channel: 'WHATSAPP', kind: 'TEMPLATE', templateId: template.id, variables: { '1': 'Asha' } }, DEPS);
  const queued = await approveAndSendMessage(owner, { messageId: draft.messageId }, DEPS);
  return { lead, ...queued };
}

async function ambiguousSend() {
  const sent = await queuedTemplateSend();
  h.wa.answer(ambiguous());
  await h.drain();
  expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: sent.attemptId } })).toMatchObject({ state: 'AMBIGUOUS' });
  expect(await h.db.job.findUniqueOrThrow({ where: { id: sent.jobId } })).toMatchObject({ status: 'DEAD', deadReason: 'AMBIGUOUS', retrySafe: false });
  return sent;
}

const post = (handler: typeof cancelPost, jobId: string, action: string, body: unknown, auth: AdminAuth | null = admin) =>
  callRoute(handler, `/api/admin/jobs/${jobId}/${action}`, auth, { body, params: { jobId } });

const REASON = 'Provider support confirmed the message never left their queue';

describe('AMBIGUOUS resolution and retry', () => {
  it('the plain job retry refuses an unresolved AMBIGUOUS attempt (no blind resend)', async () => {
    const sent = await ambiguousSend();
    const calls = h.wa.calls.length;
    const res = await post(retryPost, sent.jobId, 'retry', { reason: REASON });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AMBIGUOUS_UNRESOLVED');
    await h.drain();
    expect(h.wa.calls).toHaveLength(calls);
  });

  it('a requeue needs a typed reason and the confirm text', async () => {
    const sent = await ambiguousSend();
    const noReason = await post(resolvePost, sent.jobId, 'resolve', { attemptId: sent.attemptId, resolution: 'NOT_DELIVERED', requeue: true, confirmText: 'RESEND' });
    expect(noReason.status).toBe(400);
    const shortReason = await post(resolvePost, sent.jobId, 'resolve', { attemptId: sent.attemptId, resolution: 'NOT_DELIVERED', requeue: true, reason: 'ok', confirmText: 'RESEND' });
    expect(shortReason.status).toBe(400);
    const noConfirm = await post(resolvePost, sent.jobId, 'resolve', { attemptId: sent.attemptId, resolution: 'NOT_DELIVERED', requeue: true, reason: REASON });
    expect(noConfirm.status).toBe(422);
    expect(noConfirm.body.code).toBe('CONFIRMATION_REQUIRED');
    const wrongConfirm = await post(resolvePost, sent.jobId, 'resolve', { attemptId: sent.attemptId, resolution: 'NOT_DELIVERED', requeue: true, reason: REASON, confirmText: 'resend please' });
    expect(wrongConfirm.status).toBe(422);
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: sent.attemptId } })).toMatchObject({ state: 'AMBIGUOUS', resolvedBy: null });
  });

  it('"Verified not delivered, requeue" creates attempt N+1 on a new job that re-runs preflight and sends once', async () => {
    const sent = await ambiguousSend();
    const calls = h.wa.calls.length;
    const res = await post(resolvePost, sent.jobId, 'resolve', { attemptId: sent.attemptId, resolution: 'NOT_DELIVERED', requeue: true, reason: REASON, confirmText: 'RESEND' });
    expect(res.status).toBe(200);
    const requeued = res.body.requeued as { jobId: string; attemptId: string };
    expect(requeued.jobId).not.toBe(sent.jobId);

    const old = await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: sent.attemptId } });
    expect(old).toMatchObject({ state: 'FAILED', resolvedBy: ADMIN_ID, resolutionNote: REASON, reasonCode: 'OPERATOR_NOT_DELIVERED' });
    expect(old.resolvedAt).not.toBeNull();
    const next = await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: requeued.attemptId } });
    expect(next).toMatchObject({ state: 'QUEUED', attemptNo: 2, jobId: requeued.jobId, sendIntent: old.sendIntent, initiatedBy: old.initiatedBy, approvalId: old.approvalId });
    expect(await h.db.job.findUniqueOrThrow({ where: { id: sent.jobId } })).toMatchObject({ status: 'DEAD' });
    expect(await h.db.message.findUniqueOrThrow({ where: { id: sent.messageId } })).toMatchObject({ status: 'PENDING' });

    // Idempotent: the same resolution again changes nothing.
    const again = await post(resolvePost, sent.jobId, 'resolve', { attemptId: sent.attemptId, resolution: 'NOT_DELIVERED', requeue: true, reason: REASON, confirmText: 'RESEND' });
    expect(again.status).toBe(409);

    await h.drain();
    expect(h.wa.calls).toHaveLength(calls + 1);
    expect(h.wa.calls.at(-1)!.request.attemptId).toBe(requeued.attemptId);
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: requeued.attemptId } })).toMatchObject({ state: 'SENT' });
    expect(await attemptsOf(h.db, sent.messageId)).toHaveLength(2);
  });

  it('a Stop after the requeue cancels the new attempt: 0 provider calls', async () => {
    const sent = await ambiguousSend();
    const calls = h.wa.calls.length;
    const res = await post(resolvePost, sent.jobId, 'resolve', { attemptId: sent.attemptId, resolution: 'NOT_DELIVERED', requeue: true, reason: REASON, confirmText: 'RESEND' });
    expect(res.status).toBe(200);
    const requeued = res.body.requeued as { jobId: string; attemptId: string };
    expect((await inbound(sent.lead, { text: 'STOP' }, h.clock.now())).res.status).toBe(200);
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: requeued.attemptId } })).toMatchObject({ state: 'CANCELLED', reasonCode: 'SUPPRESSED' });
    await h.drain();
    expect(h.wa.calls).toHaveLength(calls);
  });

  it('a lead suppressed before the requeue is skipped SUPPRESSED by the preflight: 0 provider calls', async () => {
    const sent = await ambiguousSend();
    const calls = h.wa.calls.length;
    expect((await inbound(sent.lead, { text: 'STOP' }, h.clock.now())).res.status).toBe(200);
    const res = await post(resolvePost, sent.jobId, 'resolve', { attemptId: sent.attemptId, resolution: 'NOT_DELIVERED', requeue: true, reason: REASON, confirmText: 'RESEND' });
    expect(res.status).toBe(200);
    const requeued = res.body.requeued as { jobId: string; attemptId: string };
    await h.drain();
    expect(h.wa.calls).toHaveLength(calls);
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: requeued.attemptId } })).toMatchObject({ state: 'SKIPPED', reasonCode: 'SUPPRESSED' });
    expect(await h.db.message.findUniqueOrThrow({ where: { id: sent.messageId } })).toMatchObject({ status: 'NOT_SENT' });
  });

  it('"Mark delivered" closes the attempt as SENT with the operator as resolver; nothing is resent', async () => {
    const sent = await ambiguousSend();
    const calls = h.wa.calls.length;
    const res = await post(resolvePost, sent.jobId, 'resolve', { attemptId: sent.attemptId, resolution: 'DELIVERED', reason: 'Customer confirmed receipt by phone' });
    expect(res.status).toBe(200);
    expect(res.body.requeued).toBeNull();
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: sent.attemptId } })).toMatchObject({ state: 'SENT', resolvedBy: ADMIN_ID, resolutionNote: 'Customer confirmed receipt by phone' });
    expect(await h.db.message.findUniqueOrThrow({ where: { id: sent.messageId } })).toMatchObject({ status: 'SENT', statusRank: 1 });
    expect(await h.db.lead.findUniqueOrThrow({ where: { id: sent.lead.id } })).toMatchObject({ salesStage: 'CONTACTED' });
    await h.drain();
    expect(h.wa.calls).toHaveLength(calls);
  });

  it('"Verified not delivered" without requeue fails the attempt and the message', async () => {
    const sent = await ambiguousSend();
    const res = await post(resolvePost, sent.jobId, 'resolve', { attemptId: sent.attemptId, resolution: 'NOT_DELIVERED', requeue: false, reason: REASON });
    expect(res.status).toBe(200);
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: sent.attemptId } })).toMatchObject({ state: 'FAILED', resolvedBy: ADMIN_ID });
    expect(await h.db.message.findUniqueOrThrow({ where: { id: sent.messageId } })).toMatchObject({ status: 'FAILED' });
    // Now the job retry is allowed: the attempt was resolved by an operator (plan §6.2).
    const retry = await post(retryPost, sent.jobId, 'retry', { reason: REASON });
    expect(retry.status).toBe(200);
    expect(retry.body.mode).toBe('new-attempt');
    const calls = h.wa.calls.length;
    await h.drain();
    expect(h.wa.calls).toHaveLength(calls + 1);
    expect((await attemptsOf(h.db, sent.messageId)).at(-1)).toMatchObject({ state: 'SENT', attemptNo: 2 });
  });
});

describe('cancel and retry', () => {
  it('cancels a QUEUED dispatch job, its attempt and message; the worker sends nothing', async () => {
    const sent = await queuedTemplateSend();
    const calls = h.wa.calls.length;
    const res = await post(cancelPost, sent.jobId, 'cancel', { reason: 'Customer asked us to hold this send' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(await h.db.job.findUniqueOrThrow({ where: { id: sent.jobId } })).toMatchObject({ status: 'CANCELLED' });
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: sent.attemptId } })).toMatchObject({ state: 'CANCELLED', reasonCode: 'OPERATOR_CANCELLED' });
    expect(await h.db.message.findUniqueOrThrow({ where: { id: sent.messageId } })).toMatchObject({ status: 'NOT_SENT' });
    await h.drain();
    expect(h.wa.calls).toHaveLength(calls);

    const again = await post(cancelPost, sent.jobId, 'cancel', { reason: 'Customer asked us to hold this send' });
    expect(again.status).toBe(409);
  });

  it('requeues a DEAD job that has no provider side effects', async () => {
    const now = h.clock.now();
    const job = await h.db.job.create({
      data: {
        workspaceId: WS_A,
        type: 'quote.expireSweep',
        payload: {},
        status: 'DEAD',
        deadReason: 'MAX_ATTEMPTS',
        attempts: 5,
        maxAttempts: 5,
        runAt: now,
        idempotencyKey: `inspector-test-dead-${now.getTime()}`,
        correlationId: 'req_inspector_dead',
        finishedAt: now,
        lastErrorCode: 'DB_BUSY',
      },
    });
    const res = await post(retryPost, job.id, 'retry', { reason: 'Database lock contention is resolved' });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('requeued');
    expect(await h.db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'QUEUED', attempts: 0, deadReason: null, finishedAt: null });
  });

  it('a dispatch job whose retries ran out gets attempt N+1 on a new job (preflight runs again)', async () => {
    const sent = await queuedTemplateSend();
    h.wa.answer(rateLimited(1_000), rateLimited(1_000), rateLimited(1_000), rateLimited(1_000), rateLimited(1_000));
    await advanceAndDrain(h, 2_000, 8);
    expect(await h.db.job.findUniqueOrThrow({ where: { id: sent.jobId } })).toMatchObject({ status: 'DEAD', deadReason: 'MAX_ATTEMPTS' });
    const before = await attemptsOf(h.db, sent.messageId);
    expect(before.at(-1)).toMatchObject({ state: 'FAILED', failureClass: 'RETRYABLE' });
    h.wa.reset();
    const calls = h.wa.calls.length;

    const res = await post(retryPost, sent.jobId, 'retry', { reason: 'Provider rate limit window has passed' });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('new-attempt');
    await advanceAndDrain(h, 2_000, 2);
    expect(h.wa.calls).toHaveLength(calls + 1);
    const after = await attemptsOf(h.db, sent.messageId);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toMatchObject({ state: 'SENT', attemptNo: before.length + 1 });
    expect(after.at(-1)!.jobId).not.toBe(sent.jobId);
  });
});

describe('authorization and audit', () => {
  it('a non-admin gets 404 and a stale authentication gets 401 REAUTH_REQUIRED', async () => {
    const sent = await queuedTemplateSend();
    const owner = await adminSession(h, { userKey: 'owner' });
    expect((await post(cancelPost, sent.jobId, 'cancel', { reason: REASON }, owner)).status).toBe(404);
    expect((await post(cancelPost, sent.jobId, 'cancel', { reason: REASON }, null)).status).toBe(401);

    const stale = await adminSession(h, { createdAt: new Date(h.clock.now().getTime() - 16 * 60_000) });
    const res = await post(cancelPost, sent.jobId, 'cancel', { reason: REASON }, stale);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('REAUTH_REQUIRED');

    const reauthed = await adminSession(h, { createdAt: new Date(h.clock.now().getTime() - 60 * 60_000), reauthAt: new Date(h.clock.now().getTime() - 60_000) });
    expect((await post(cancelPost, sent.jobId, 'cancel', { reason: REASON }, reauthed)).status).toBe(200);
  });

  it('an unknown job is 404', async () => {
    expect((await post(cancelPost, 'nojobwiththisid000000000', 'cancel', { reason: REASON })).status).toBe(404);
  });

  it('every action is audited crossWorkspace with the reason, after an admin.elevate row', async () => {
    const rows = await h.db.auditEvent.findMany({ where: { actorUserId: ADMIN_ID, action: { in: ['job.cancel', 'job.retry', 'dispatch.operator_resolve'] } } });
    const actions = new Set(rows.map((r) => r.action));
    expect(actions).toEqual(new Set(['job.cancel', 'job.retry', 'dispatch.operator_resolve']));
    for (const row of rows) {
      expect(row.crossWorkspace).toBe(true);
      expect(row.actorKind).toBe('SUPER_ADMIN');
      expect(row.reason && row.reason.length).toBeGreaterThan(3);
    }
    const elevations = await h.db.auditEvent.count({ where: { actorUserId: ADMIN_ID, action: 'admin.elevate', workspaceId: WS_A } });
    expect(elevations).toBeGreaterThanOrEqual(rows.length);
  });
});
