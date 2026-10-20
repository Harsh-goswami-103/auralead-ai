/**
 * R33 (T24) inspector reads: the job list (filters, retry-waiting label), the job detail
 * (redacted payload, attempt log, dispatch attempts, correlation timeline, which actions apply),
 * and the webhook inspector (redacted payload only, payload-held flag, the jobs that processed the
 * event). Super admin only: any other role gets 404.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getWebhookEventDetail, listWebhookEvents } from '@/server/services/admin/webhook-inspector';
import { getJobDetail, listJobs } from '@/server/services/jobs-admin/inspector';
import { approveAndSendMessage, createMessageDraft } from '@/server/services/messaging/dispatch';
import { ambiguous, approvedTemplate, createLead, DEPS, grantConsent } from '../dispatch/support';
import { createInboundHarness, inbound, type InboundHarness } from '../messaging/inbound-support';
import { userCtx } from '../quotes/support';
import { adminCtx } from './support';

let h: InboundHarness;
beforeAll(async () => {
  h = await createInboundHarness('inspector-reads');
}, 120_000);
afterAll(async () => h?.destroy());

describe('inspector reads', () => {
  it('shows a dispatch job with its redacted payload, attempts, timeline and the actions that apply', async () => {
    const lead = await createLead(h.db);
    await grantConsent(h.db, lead, 'WHATSAPP');
    const owner = await h.owner();
    const template = await approvedTemplate(h.db);
    const draft = await createMessageDraft(owner, { leadId: lead.id, channel: 'WHATSAPP', kind: 'TEMPLATE', templateId: template.id, variables: { '1': 'Asha' } }, DEPS);
    const sent = await approveAndSendMessage(owner, { messageId: draft.messageId }, DEPS);
    h.wa.answer(ambiguous());
    await h.drain();

    const admin = await adminCtx(h);
    const detail = await getJobDetail(admin, sent.jobId);
    expect(detail.job).toMatchObject({ type: 'dispatch.whatsapp', status: 'DEAD', label: 'Dead: delivery unknown', payload: { messageId: sent.messageId } });
    expect(detail.job.workspace?.slug).toBe('smile-avenue-dental');
    expect(detail.attempts).toHaveLength(1);
    expect(detail.attempts[0]).toMatchObject({ outcome: 'AMBIGUOUS' });
    expect(detail.dispatchAttempts.map((a) => a.state)).toEqual(['AMBIGUOUS']);
    expect(detail.actions).toMatchObject({ cancel: false, retry: { allowed: false, code: 'AMBIGUOUS_UNRESOLVED' }, resolvableAttemptIds: [sent.attemptId] });
    const labels = detail.timeline.map((t) => t.label);
    expect(labels).toContain('dispatch.queue');
    expect(labels).toContain('dispatch.whatsapp enqueued');
    expect(labels).toContain('attempt 1');
    const times = detail.timeline.map((t) => t.at.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);

    const dead = await listJobs(admin, { status: 'DEAD' });
    expect(dead.rows.map((r) => r.id)).toContain(sent.jobId);
    expect(dead.rows.every((r) => r.status === 'DEAD')).toBe(true);
    expect(dead.types).toContain('dispatch.whatsapp');
    const byType = await listJobs(admin, { type: 'dispatch.whatsapp', limit: 1 });
    expect(byType.rows).toHaveLength(1);
  });

  it('labels a QUEUED job with a later run time as retry waiting', async () => {
    const now = h.clock.now();
    await h.db.job.create({ data: { type: 'test.wait', payload: {}, status: 'QUEUED', runAt: new Date(now.getTime() + 60_000), idempotencyKey: 'reads:waiting', correlationId: 'req_reads', createdAt: now } });
    const rows = (await listJobs(await adminCtx(h), { type: 'test.wait' })).rows;
    expect(rows[0]).toMatchObject({ label: 'Retry waiting', workspace: null });
  });

  it('shows a webhook event redacted, with the job that processed it', async () => {
    const lead = await createLead(h.db);
    const { id } = await inbound(lead, { text: 'Hello, is Saturday open?' }, h.clock.now());
    await h.drain();
    const admin = await adminCtx(h);
    const list = await listWebhookEvents(admin, { provider: 'WHATSAPP', status: 'PROCESSED' });
    const row = list.rows.find((r) => r.externalKey === `wa:${id}`);
    expect(row).toBeDefined();
    const detail = await getWebhookEventDetail(admin, row!.id);
    expect(detail.jobs.map((j) => j.type)).toContain('webhook.process');
    // The page tells a failed job waiting to retry from a scheduled one by its attempts.
    for (const j of detail.jobs) {
      const stored = await h.db.job.findUniqueOrThrow({ where: { id: j.id }, select: { attempts: true } });
      expect(j.attempts).toBe(stored.attempts);
    }
    const text = JSON.stringify(detail);
    expect(text).not.toContain('Saturday');
    expect(text).not.toContain(lead.phoneE164!);
    expect(text).not.toContain('processingPayload');
  });

  it('refuses every other role with 404', async () => {
    const owner = await userCtx(h.db, h.clock, 'owner');
    await expect(listJobs(owner)).rejects.toMatchObject({ status: 404 });
    await expect(listWebhookEvents(owner)).rejects.toMatchObject({ status: 404 });
  });
});
