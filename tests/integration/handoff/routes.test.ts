// ADR-124 (lead-gen F5): the handoff routes in-process, as the panels call them.
// - POST /api/app/leads/[leadId]/handoff: the operator names the workspace by slug; CSRF is
//   required; a second handoff is 409; the per-person `handoff` rate limit answers 429.
// - GET /api/app/handoffs: the client's list (USER only; an operator gets 404).
// - POST /api/app/handoffs/[handoffId]/acknowledge: the client acknowledges (an operator gets 404).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as listRoute } from '@/app/api/app/handoffs/route';
import { POST as acknowledgeRoute } from '@/app/api/app/handoffs/[handoffId]/acknowledge/route';
import { POST as handoffRoute } from '@/app/api/app/leads/[leadId]/handoff/route';
import { RATE_LIMIT_POLICIES } from '@/server/security/rate-limit';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { seedId } from '../../../prisma/seed/ids';
import { makeRequest } from '../auth/support';
import { leadWithConversation } from '../messaging/conversation-support';
import { createInboundHarness, type InboundHarness } from '../messaging/inbound-support';
import { operatorWithHandoff, requestKey } from './support';

let h: InboundHarness;
const WS_A_SLUG = 'smile-avenue-dental';

beforeAll(async () => {
  h = await createInboundHarness('handoff-routes');
  await operatorWithHandoff(h);
}, 120_000);
afterAll(async () => {
  await h?.destroy();
});

async function auth(userKey: string) {
  const user = await h.db.user.findUniqueOrThrow({ where: { id: seedId('user', userKey) } });
  const { token, session } = await createSession(h.db, { userId: user.id, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'handoff', userAgent: 'vitest', now: h.clock.now() });
  return { cookie: `${sessionCookieName(h.config)}=${token}`, csrf: csrfTokenForSession(h.config, session.id) };
}

async function json(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function handOver(userKey: string, leadId: string, body: Record<string, unknown>, opts: { csrf?: boolean } = {}) {
  const a = await auth(userKey);
  const url = `/api/app/leads/${leadId}/handoff`;
  return json(await handoffRoute(makeRequest(url, { body, cookie: a.cookie, csrf: opts.csrf === false ? undefined : a.csrf }), { params: Promise.resolve({ leadId }) }));
}

const stageVersion = async (leadId: string) => (await h.db.lead.findUniqueOrThrow({ where: { id: leadId } })).stageVersion;

describe('POST /api/app/leads/[leadId]/handoff', () => {
  it('hands the lead over for the operator (by slug), then answers 409 to a second handoff', async () => {
    const { lead } = await leadWithConversation(h, 'We need a new website');
    const body = { workspaceSlug: WS_A_SLUG, expectedStageVersion: await stageVersion(lead.id), note: 'Hot lead', requestKey: requestKey('route') };
    expect((await handOver('employee', lead.id, body, { csrf: false })).status).toBe(403);
    const first = await handOver('employee', lead.id, body);
    expect(first).toMatchObject({ status: 200, body: { created: true, summaryStatus: 'PENDING', lead: { id: lead.id, salesStage: 'CONVERTED' } } });
    const again = await handOver('employee', lead.id, { ...body, requestKey: requestKey('route'), expectedStageVersion: await stageVersion(lead.id) });
    expect(again).toMatchObject({ status: 409, body: { code: 'ALREADY_HANDED_OVER' } });
    // Without the slug the operator has no workspace selected: 404, nothing written.
    expect((await handOver('employee', lead.id, { expectedStageVersion: 0, requestKey: requestKey('route') })).status).toBe(404);
    expect(await h.db.leadHandoff.count({ where: { leadId: lead.id } })).toBe(1);
  });

  it('a stale version is 409 STAGE_VERSION_CONFLICT; an invalid body is 400', async () => {
    const { lead } = await leadWithConversation(h, 'Hello');
    const stale = await handOver('employee', lead.id, { workspaceSlug: WS_A_SLUG, expectedStageVersion: (await stageVersion(lead.id)) + 3, requestKey: requestKey('route') });
    expect(stale).toMatchObject({ status: 409, body: { code: 'STAGE_VERSION_CONFLICT' } });
    expect((await handOver('employee', lead.id, { workspaceSlug: WS_A_SLUG, expectedStageVersion: 0, requestKey: 'x' })).status).toBe(400);
    expect((await handOver('employee', lead.id, { workspaceSlug: WS_A_SLUG, expectedStageVersion: 0, requestKey: requestKey('route'), note: 'n'.repeat(1001) })).status).toBe(400);
  });

  it('is limited per person (handoff policy): 429 once the bucket is empty', async () => {
    const { lead } = await leadWithConversation(h, 'Hi again');
    const limiter = h.runtime.limiters.handoff;
    const key = `handoff:${seedId('user', 'employee')}`;
    for (let i = 0; i < RATE_LIMIT_POLICIES.handoff.limit; i += 1) limiter.take(key);
    const limited = await handOver('employee', lead.id, { workspaceSlug: WS_A_SLUG, expectedStageVersion: await stageVersion(lead.id), requestKey: requestKey('route') });
    expect(limited).toMatchObject({ status: 429, body: { code: 'RATE_LIMITED' } });
    expect(await h.db.leadHandoff.count({ where: { leadId: lead.id } })).toBe(0);
    h.clock.advance(RATE_LIMIT_POLICIES.handoff.windowMs);
  });
});

describe('the client routes', () => {
  it('lists handoffs for the client and acknowledges one; an operator gets 404 on both', async () => {
    const { lead } = await leadWithConversation(h, 'Please call me');
    const created = await handOver('employee', lead.id, { workspaceSlug: WS_A_SLUG, expectedStageVersion: await stageVersion(lead.id), requestKey: requestKey('route') });
    const handoffId = String(created.body.handoffId);

    const owner = await auth('owner');
    const open = await json(await listRoute(makeRequest('/api/app/handoffs?status=open', { cookie: owner.cookie }), { params: Promise.resolve({}) }));
    expect(open.status).toBe(200);
    expect((open.body.handoffs as Array<{ id: string }>).map((x) => x.id)).toContain(handoffId);
    expect((await listRoute(makeRequest('/api/app/handoffs?status=nope', { cookie: owner.cookie }), { params: Promise.resolve({}) })).status).toBe(400);

    const employee = await auth('employee');
    expect((await listRoute(makeRequest('/api/app/handoffs', { cookie: employee.cookie }), { params: Promise.resolve({}) })).status).toBe(404);
    const params = { params: Promise.resolve({ handoffId }) };
    expect((await acknowledgeRoute(makeRequest(`/api/app/handoffs/${handoffId}/acknowledge`, { body: {}, cookie: employee.cookie, csrf: employee.csrf }), params)).status).toBe(404);

    const ack = await json(await acknowledgeRoute(makeRequest(`/api/app/handoffs/${handoffId}/acknowledge`, { body: {}, cookie: owner.cookie, csrf: owner.csrf }), params));
    expect(ack).toEqual({ status: 200, body: { handoffId, status: 'ACKNOWLEDGED', changed: true } });
    const rohan = await auth('rohan');
    expect((await acknowledgeRoute(makeRequest(`/api/app/handoffs/${handoffId}/acknowledge`, { body: {}, cookie: rohan.cookie, csrf: rohan.csrf }), params)).status).toBe(404);
  });
});
