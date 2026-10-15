/**
 * R33 (T24) queue health: worker liveness from the heartbeat row (older than 30 s reads "Worker
 * not running"), the AMBIGUOUS attempt count, the age of the oldest due QUEUED job, retry-waiting
 * jobs (QUEUED with a future runAt) and counts per status; the GET route is super-admin only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as healthGet } from '@/app/api/admin/system/queue-health/route';
import { loadQueueHealth, WORKER_NOT_RUNNING_LABEL } from '@/server/services/jobs-admin/queue-health';
import { approveAndSendMessage, createMessageDraft } from '@/server/services/messaging/dispatch';
import { ambiguous, approvedTemplate, createLead, DEPS, grantConsent } from '../dispatch/support';
import { createInboundHarness, type InboundHarness } from '../messaging/inbound-support';
import { adminCtx, adminSession, callRoute } from './support';

let h: InboundHarness;
beforeAll(async () => {
  h = await createInboundHarness('queue-health');
}, 120_000);
afterAll(async () => h?.destroy());

const MIN = 60_000;

async function beat(ageMs: number, workerId = 'worker-test') {
  const at = new Date(h.clock.now().getTime() - ageMs);
  await h.db.workerHeartbeat.upsert({
    where: { workerId },
    create: { workerId, pid: 4242, hostname: 'test-host', version: 'test', mode: 'DEMO', startedAt: at, lastBeatAt: at },
    update: { lastBeatAt: at },
  });
}

async function job(key: string, status: 'QUEUED' | 'DEAD' | 'RUNNING', runAt: Date) {
  return h.db.job.create({ data: { type: 'test.health', payload: {}, status, runAt, idempotencyKey: `health:${key}`, correlationId: 'req_health', workspaceId: null, createdAt: runAt } });
}

describe('queue health', () => {
  it('reports "Worker not running" with no heartbeat at all', async () => {
    await h.db.workerHeartbeat.deleteMany();
    const health = await loadQueueHealth(await adminCtx(h));
    expect(health.worker.running).toBe(false);
    expect(health.worker.label).toBe(WORKER_NOT_RUNNING_LABEL);
    expect(health.worker.lastBeatAt).toBeNull();
  });

  it('a heartbeat 10 s old is running; one older than 30 s is "Worker not running"', async () => {
    await beat(10_000);
    let health = await loadQueueHealth(await adminCtx(h));
    expect(health.worker).toMatchObject({ running: true, label: 'Running', workerId: 'worker-test' });

    await beat(30_001);
    health = await loadQueueHealth(await adminCtx(h));
    expect(health.worker).toMatchObject({ running: false, label: WORKER_NOT_RUNNING_LABEL });
    expect(health.worker.ageMs).toBe(30_001);
  });

  it('counts AMBIGUOUS attempts, the oldest due QUEUED job and retry-waiting jobs', async () => {
    const before = await loadQueueHealth(await adminCtx(h));
    expect(before.ambiguousAttempts).toBe(0);

    // One AMBIGUOUS dispatch (provider timeout after the write).
    const lead = await createLead(h.db);
    await grantConsent(h.db, lead, 'WHATSAPP');
    const owner = await h.owner();
    const template = await approvedTemplate(h.db);
    const draft = await createMessageDraft(owner, { leadId: lead.id, channel: 'WHATSAPP', kind: 'TEMPLATE', templateId: template.id, variables: { '1': 'Asha' } }, DEPS);
    await approveAndSendMessage(owner, { messageId: draft.messageId }, DEPS);
    h.wa.answer(ambiguous());
    await h.drain();

    const now = h.clock.now().getTime();
    await job('old', 'QUEUED', new Date(now - 5 * MIN));
    await job('newer', 'QUEUED', new Date(now - 1 * MIN));
    await job('waiting', 'QUEUED', new Date(now + 10 * MIN));
    await job('dead', 'DEAD', new Date(now - 2 * MIN));

    const health = await loadQueueHealth(await adminCtx(h));
    expect(health.ambiguousAttempts).toBe(1);
    expect(health.oldestDueQueued).toMatchObject({ ageMs: 5 * MIN });
    expect(health.retryWaiting).toBe(1);
    expect(health.dueQueued).toBe(2);
    expect(health.byStatus.DEAD).toBeGreaterThanOrEqual(2);
    expect(health.byStatus.QUEUED).toBe(3);
  });

  it('the GET route answers the same read model to a super admin and 404 to anyone else', async () => {
    // The in-process worker's own heartbeat (written while draining) is replaced by a stale one.
    await h.db.workerHeartbeat.deleteMany();
    await beat(45_000);
    const admin = await adminSession(h);
    const res = await callRoute(healthGet, '/api/admin/system/queue-health', admin);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ambiguousAttempts: 1, retryWaiting: 1, worker: { label: WORKER_NOT_RUNNING_LABEL } });
    const owner = await adminSession(h, { userKey: 'owner' });
    expect((await callRoute(healthGet, '/api/admin/system/queue-health', owner)).status).toBe(404);
    expect((await callRoute(healthGet, '/api/admin/system/queue-health', null)).status).toBe(401);
  });
});
