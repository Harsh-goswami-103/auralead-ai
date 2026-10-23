/**
 * Helpers shared by the cross-slice lead-gen tests (integrator): signed-in route calls for a seeded
 * persona, a snapshot of everything that could leave the product
 * for one lead. The slices' own harnesses (inbound, finder, import, templates) stay where they are;
 * these tests compose them.
 */
import type { PrismaClient } from '@/generated/prisma/client';
import type { AppConfig } from '@/lib/config';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { seedId } from '../../../prisma/seed/ids';
import { makeRequest } from '../auth/support';

export type RouteHandler = (req: Request, seg: { params: Promise<Record<string, string>> }) => Promise<Response>;

type AuthHarness = { db: PrismaClient; clock: { now(): Date }; config: AppConfig };

/** A session cookie and CSRF token for a seeded persona (`owner`, `employee`, `client`, ...). */
export async function personaAuth(h: AuthHarness, userKey: string) {
  const user = await h.db.user.findUniqueOrThrow({ where: { id: seedId('user', userKey) } });
  const { token, session } = await createSession(h.db, { userId: user.id, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'lead-gen', userAgent: 'vitest', now: h.clock.now() });
  return { cookie: `${sessionCookieName(h.config)}=${token}`, csrf: csrfTokenForSession(h.config, session.id) };
}

/** Calls a route handler in-process as `userKey`; the JSON body is returned with the status. */
export async function callRoute(h: AuthHarness, route: RouteHandler, url: string, userKey: string, body: unknown, params: Record<string, string> = {}) {
  const auth = await personaAuth(h, userKey);
  const res = await route(makeRequest(url, { body, cookie: auth.cookie, csrf: auth.csrf }), { params: Promise.resolve(params) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/**
 * Everything that records "a message left for this lead": business messages that are not drafts,
 * their dispatch attempts and dispatch jobs, and the approvals still waiting. Equal before and
 * after means nothing was queued, drafted into the outbox or sent.
 */
export async function outboundFootprint(db: PrismaClient, leadId: string) {
  const conversations = await db.conversation.findMany({ where: { leadId }, select: { id: true } });
  const conversationIds = conversations.map((c) => c.id);
  const messages = await db.message.findMany({ where: { conversationId: { in: conversationIds }, direction: 'OUT' }, select: { id: true, status: true } });
  const messageIds = messages.map((m) => m.id);
  const attempts = await db.dispatchAttempt.findMany({ where: { messageId: { in: messageIds } }, select: { id: true, state: true, jobId: true } });
  const jobs = await db.job.findMany({ where: { id: { in: attempts.map((a) => a.jobId) } }, select: { id: true, status: true } });
  const sendable = messages.filter((m) => m.status !== 'DRAFT' && m.status !== 'NOT_SENT');
  return {
    outMessages: messages.map((m) => `${m.id}:${m.status}`).sort(),
    sendable: sendable.length,
    attempts: attempts.map((a) => `${a.id}:${a.state}`).sort(),
    jobs: jobs.map((j) => `${j.id}:${j.status}`).sort(),
  };
}

/**
 * An APPROVED authored MARKETING template with a per-lead greeting ({{1}} = the lead's display name, which suits a business found on a map),
 * the business name ({{2}}) and the STOP quick reply: the shape the template studio produces.
 * The WhatsApp integration (SIMULATED) is created when the workspace has none.
 */
export async function approvedMarketingTemplate(db: PrismaClient, workspaceId: string, name = 'lead_gen_intro') {
  const integration =
    (await db.integration.findFirst({ where: { workspaceId, kind: 'WHATSAPP_CLOUD' } })) ?? (await db.integration.create({ data: { workspaceId, kind: 'WHATSAPP_CLOUD', status: 'SIMULATED', config: {} } }));
  const existing = await db.whatsAppTemplate.findFirst({ where: { integrationId: integration.id, name } });
  if (existing) return existing;
  return db.whatsAppTemplate.create({
    data: {
      workspaceId,
      integrationId: integration.id,
      name,
      language: 'en',
      category: 'MARKETING',
      status: 'APPROVED',
      origin: 'AUTHORED',
      components: [{ type: 'BODY', text: 'Hello {{1}}, {{2}} builds fast websites for local businesses. Would you like to see a sample homepage?' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Stop' }] }],
      variableSchema: [],
      variableMap: { body: { '1': 'lead.displayName', '2': 'workspace.name' }, buttons: { '0': 'STOP' } },
      categoryHistory: [],
      syncedAt: new Date('2026-10-15T00:00:00.000Z'),
    },
  });
}
