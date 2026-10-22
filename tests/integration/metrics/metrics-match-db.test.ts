/**
 * T25 / R31 / AT13 / O6: every command-center widget equals a direct count or sum over the stored
 * rows, computed here independently (plain queries plus the quote status rules in JS).
 *  - Pipeline value is the current-version total of SENT and VIEWED quotes still inside their
 *    validity; DRAFT, APPROVED, ACCEPTED, CANCELLED and EXPIRED (stored, or validity passed before
 *    the sweep ran) are excluded, and only the current version of a revised quote counts.
 *  - "Accepted quote value" sums the accepted versions; "Confirmed revenue" is unavailable because
 *    AuraLead records no payments (O6, ADR-28).
 *  - Everything is tenant-scoped: workspace B rows never move workspace A's numbers.
 *  - The admin global metrics (totals and the workspace table) equal the same direct reads per
 *    workspace, and the command-center page renders the O6 labels.
 */
import { createElement, type FC, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { CsrfProvider } from '@/components/patterns/csrf';
import { NotFoundError } from '@/lib/errors';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { loadClientCommandCenter, type ClientCommandCenter } from '@/server/services/metrics/command-center';
import { CLIENT_METRICS, CONFIRMED_REVENUE, NEEDS_YOU_ITEMS } from '@/server/services/metrics/definitions';
import { loadPlatformMetrics, PLATFORM_METRICS } from '@/server/services/metrics/platform';
import { settleWidget } from '@/server/services/metrics/widget';
import { effectiveQuoteStatus } from '@/server/services/quotes/versioning';
import { seedId } from '../../../prisma/seed/ids';
import { testConfig, uninstallRuntime, useRuntime } from '../auth/support';
import {
  ago,
  ahead,
  createMetricsHarness,
  ctxFor,
  DAY,
  destroyHarness,
  insertApproval,
  insertAudit,
  insertCallRequest,
  insertConversation,
  insertLead,
  insertOutbound,
  insertQuote,
  NOW,
  OWNER_A,
  WS_A,
  WS_B,
  type MetricsHarness,
} from './support';

const pageHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => pageHeaders.current }));
vi.mock('next/navigation', async (orig) => ({ ...(await orig<typeof import('next/navigation')>()), useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));

let h: MetricsHarness;
let db: PrismaClient;

const value = <T,>(o: { ok: true; value: T } | { ok: false; reference: string }): T => {
  if (!o.ok) throw new Error(`widget failed (${o.reference})`);
  return o.value;
};

beforeAll(async () => {
  h = await createMetricsHarness('metrics-match-db');
  db = h.db;

  // Leads: two new this week (one merged away), older ones in each stage, plus workspace B noise.
  const keep = await insertLead(db, { stage: 'NEW', createdAt: ago(2 * DAY) });
  await insertLead(db, { stage: 'NEW', createdAt: ago(3 * DAY), mergedIntoLeadId: keep.id });
  await insertLead(db, { stage: 'CONTACTED', createdAt: ago(6 * DAY + 23 * 3_600_000) });
  await insertLead(db, { stage: 'REPLIED', createdAt: ago(8 * DAY) });
  await insertLead(db, { stage: 'LOST', createdAt: ago(40 * DAY) });
  await insertLead(db, { workspaceId: WS_B, stage: 'NEW', createdAt: ago(DAY) });

  // Quotes in every status (A), and a SENT one in B.
  await insertQuote(db, { status: 'DRAFT', totals: [100_000n] });
  await insertQuote(db, { status: 'APPROVED', totals: [200_000n] });
  await insertQuote(db, { status: 'SENT', totals: [999_999n, 300_000n] }); // revised: only v2 counts
  await insertQuote(db, { status: 'VIEWED', totals: [400_000n] });
  await insertQuote(db, { status: 'SENT', totals: [500_000n], validUntil: ago(60_000) }); // reads EXPIRED
  await insertQuote(db, { status: 'EXPIRED', totals: [600_000n], validUntil: ago(DAY) });
  await insertQuote(db, { status: 'CANCELLED', totals: [700_000n] });
  await insertQuote(db, { status: 'ACCEPTED', totals: [800_000n] });
  await insertQuote(db, { status: 'ACCEPTED', totals: [50_000n, 850_000n] });
  await insertQuote(db, { workspaceId: WS_B, status: 'SENT', totals: [1_234_500n] });
  await insertQuote(db, { workspaceId: WS_B, status: 'ACCEPTED', totals: [42_000n] });

  // Conversations and outbound messages.
  const open = await insertConversation(db);
  await insertConversation(db, { takeover: true });
  await insertConversation(db, { closed: true });
  await insertConversation(db, { workspaceId: WS_B, takeover: true });
  await insertOutbound(db, { conversationId: open.id, status: 'FAILED', createdAt: ago(DAY) });
  await insertOutbound(db, { conversationId: open.id, status: 'FAILED', createdAt: ago(9 * DAY) }); // older than 7 days
  await insertOutbound(db, { conversationId: open.id, status: 'UNKNOWN', createdAt: ago(20 * DAY) }); // unknown stays until resolved
  await insertOutbound(db, { conversationId: open.id, status: 'DELIVERED' });

  // Approvals: pending quote and message items, one approval withdrawn by an edit after approval.
  const draft = await insertQuote(db, { status: 'DRAFT', totals: [10_000n] });
  await insertApproval(db, { kind: 'QUOTE_VERSION', status: 'PENDING', quoteId: draft.quote.id, quoteVersionId: draft.versionId });
  const msg = await insertOutbound(db, { conversationId: open.id, status: 'DRAFT' });
  await insertApproval(db, { kind: 'OUTBOUND_MESSAGE', status: 'PENDING', messageId: msg.id });
  await insertApproval(db, { kind: 'QUOTE_VERSION', status: 'INVALIDATED', quoteId: draft.quote.id, decidedBy: OWNER_A, decidedAt: ago(2 * DAY), invalidatedAt: ago(DAY), invalidationReason: 'QUOTE_REVISED' });
  await insertApproval(db, { kind: 'QUOTE_VERSION', status: 'INVALIDATED', quoteId: draft.quote.id, invalidatedAt: ago(DAY), invalidationReason: 'QUOTE_REVISED' }); // never approved: not "edited after approval"
  await insertApproval(db, { kind: 'QUOTE_VERSION', status: 'INVALIDATED', quoteId: draft.quote.id, decidedBy: OWNER_A, decidedAt: ago(20 * DAY), invalidatedAt: ago(15 * DAY), invalidationReason: 'QUOTE_REVISED' }); // too old

  await insertCallRequest(db, { status: 'OPEN' });
  await insertCallRequest(db, { status: 'DONE' });
  await insertCallRequest(db, { workspaceId: WS_B, status: 'OPEN' });

  await insertAudit(db, { action: 'quote.approve', actorUserId: OWNER_A, actorKind: 'USER', targetType: 'Quote', targetId: draft.quote.id, createdAt: ago(60_000) });
  await insertAudit(db, { workspaceId: WS_B, action: 'quote.cancel', actorKind: 'USER', targetType: 'Quote', createdAt: ago(30_000) });
});

afterAll(async () => {
  await destroyHarness(h);
});

/** The quote rules computed independently from the rows: current or accepted version totals in JS. */
async function directQuoteSums(workspaceId: string) {
  const quotes = await db.quote.findMany({ where: { workspaceId }, include: { currentVersion: true, acceptedVersion: true } });
  let pipeline = 0n;
  let pipelineCount = 0;
  let accepted = 0n;
  let acceptedCount = 0;
  for (const q of quotes) {
    const effective = effectiveQuoteStatus(q, NOW);
    if ((effective === 'SENT' || effective === 'VIEWED') && q.currentVersion) {
      pipeline += q.currentVersion.totalPaise;
      pipelineCount += 1;
    }
    if (q.status === 'ACCEPTED' && q.acceptedVersion) {
      accepted += q.acceptedVersion.totalPaise;
      acceptedCount += 1;
    }
  }
  return { pipeline, pipelineCount, accepted, acceptedCount, drafts: quotes.filter((q) => q.status === 'DRAFT').length };
}

async function directCounts(workspaceId: string) {
  const weekAgo = new Date(NOW.getTime() - 7 * DAY);
  const leads = await db.lead.findMany({ where: { workspaceId } });
  const live = leads.filter((l) => l.mergedIntoLeadId === null);
  const conversations = await db.conversation.findMany({ where: { workspaceId } });
  return {
    newLeads: live.filter((l) => l.createdAt.getTime() >= weekAgo.getTime()).length,
    leads: live.length,
    stages: Object.fromEntries(['NEW', 'CONTACTED', 'REPLIED', 'QUOTE_SENT', 'CONVERTED', 'LOST'].map((s) => [s, live.filter((l) => l.salesStage === s).length])),
    openConversations: conversations.filter((c) => c.closedAt === null).length,
    takeover: conversations.filter((c) => c.closedAt === null && c.humanTakeover).length,
  };
}

describe('client command center (workspace A owner)', () => {
  let cc: ClientCommandCenter;
  beforeAll(async () => {
    cc = await loadClientCommandCenter(await ctxFor(h, 'owner'));
  });

  it('KPIs equal direct counts: new leads (7 days, merged excluded), open conversations, quotes awaiting approval', async () => {
    const d = await directCounts(WS_A);
    const q = await directQuoteSums(WS_A);
    expect(value(cc.kpis.newLeads)).toBe(d.newLeads);
    expect(d.newLeads).toBe(2); // 2 days and 6d23h ago; the merged one and older ones excluded
    expect(value(cc.kpis.openConversations)).toBe(d.openConversations);
    expect(value(cc.kpis.openConversations)).toBe(2); // the closed one is not open
    expect(value(cc.kpis.quotesAwaitingApproval)).toBe(q.drafts);
    expect(value(cc.kpis.quotesAwaitingApproval)).toBe(2);
  });

  it('pipeline value is SENT + VIEWED current-version totals within validity; CANCELLED and EXPIRED excluded', async () => {
    const q = await directQuoteSums(WS_A);
    const pipeline = value(cc.kpis.pipelineValue);
    expect(pipeline).toEqual({ paise: q.pipeline, count: q.pipelineCount });
    expect(pipeline).toEqual({ paise: 700_000n, count: 2 }); // 300,000 (v2) + 400,000

    // Adding a cancelled and an expired quote leaves it unchanged; a sent one adds its total.
    await insertQuote(db, { status: 'CANCELLED', totals: [5_000_000n] });
    await insertQuote(db, { status: 'EXPIRED', totals: [6_000_000n], validUntil: ago(DAY) });
    await insertQuote(db, { status: 'VIEWED', totals: [7_000_000n], validUntil: ago(1) });
    const again = await loadClientCommandCenter(await ctxFor(h, 'owner'));
    expect(value(again.kpis.pipelineValue)).toEqual({ paise: 700_000n, count: 2 });
    await insertQuote(db, { status: 'SENT', totals: [11_000n], validUntil: ahead(DAY) });
    const more = await loadClientCommandCenter(await ctxFor(h, 'owner'));
    expect(value(more.kpis.pipelineValue)).toEqual({ paise: 711_000n, count: 3 });
    expect(value(more.kpis.pipelineValue)).toEqual({ paise: (await directQuoteSums(WS_A)).pipeline, count: (await directQuoteSums(WS_A)).pipelineCount });
  });

  it('"Accepted quote value" sums accepted versions; "Confirmed revenue" is unavailable (O6)', async () => {
    const q = await directQuoteSums(WS_A);
    expect(value(cc.kpis.acceptedQuoteValue)).toEqual({ paise: q.accepted, count: q.acceptedCount });
    expect(value(cc.kpis.acceptedQuoteValue)).toEqual({ paise: 1_650_000n, count: 2 });
    expect(CLIENT_METRICS.acceptedQuoteValue.label).toBe('Accepted quote value');
    expect(CLIENT_METRICS.pipelineValue.label).toBe('Pipeline value');
    expect(cc.kpis.confirmedRevenue).toEqual({ available: false, label: 'Confirmed revenue', value: 'Unavailable', reason: 'No payment data' });
    expect(CONFIRMED_REVENUE.definition).toMatch(/does not record payments/);
    expect(CLIENT_METRICS.acceptedQuoteValue.definition).toMatch(/not.*payment/i);
  });

  it('"Needs you" counts equal the stored approvals, deliveries, takeovers and call requests', async () => {
    const items = value(cc.needsYou);
    const byId = Object.fromEntries(items.map((i) => [i.id, i.count]));
    const weekAgo = new Date(NOW.getTime() - 7 * DAY);
    expect(byId).toEqual({
      quoteApprovals: await db.approval.count({ where: { workspaceId: WS_A, kind: 'QUOTE_VERSION', status: 'PENDING' } }),
      messageApprovals: await db.approval.count({ where: { workspaceId: WS_A, kind: 'OUTBOUND_MESSAGE', status: 'PENDING' } }),
      invalidatedApprovals: await db.approval.count({
        where: { workspaceId: WS_A, kind: 'QUOTE_VERSION', status: 'INVALIDATED', invalidationReason: 'QUOTE_REVISED', decidedAt: { not: null }, invalidatedAt: { gte: weekAgo } },
      }),
      failedDeliveries: await db.message.count({ where: { workspaceId: WS_A, direction: 'OUT', status: 'FAILED', createdAt: { gte: weekAgo } } }),
      unknownDeliveries: await db.message.count({ where: { workspaceId: WS_A, direction: 'OUT', status: 'UNKNOWN' } }),
      takeoverThreads: (await directCounts(WS_A)).takeover,
      openCallRequests: await db.callRequest.count({ where: { workspaceId: WS_A, status: 'OPEN' } }),
    });
    expect(byId).toMatchObject({ quoteApprovals: 1, messageApprovals: 1, invalidatedApprovals: 1, failedDeliveries: 1, unknownDeliveries: 1, takeoverThreads: 1, openCallRequests: 1 });
    for (const item of items) {
      expect(item.definition.length).toBeGreaterThan(20);
      expect(item.label).toBe(NEEDS_YOU_ITEMS[item.id].label);
    }
  });

  it('the funnel equals the lead count per sales stage (merged leads excluded)', async () => {
    const d = await directCounts(WS_A);
    const funnel = value((await loadClientCommandCenter(await ctxFor(h, 'owner'))).funnel);
    expect(Object.fromEntries(funnel.stages.map((s) => [s.stage, s.count]))).toEqual(d.stages);
    expect(funnel.total).toBe(d.leads);
  });

  it('activity lists the latest audit rows of this workspace only, newest first, with actor names', async () => {
    const activity = value(cc.activity);
    const direct = await db.auditEvent.findMany({ where: { workspaceId: WS_A }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: activity.length });
    expect(activity.map((a) => a.id)).toEqual(direct.map((a) => a.id));
    expect(activity[0]).toMatchObject({ action: 'quote.approve', actorName: 'Ananya Sharma', targetType: 'Quote' });
    expect(activity.some((a) => a.action === 'quote.cancel')).toBe(false);
  });

  it('workspace B sees only its own rows', async () => {
    const b = await loadClientCommandCenter(await ctxFor(h, 'rohan'));
    const q = await directQuoteSums(WS_B);
    expect(value(b.kpis.pipelineValue)).toEqual({ paise: q.pipeline, count: q.pipelineCount });
    expect(value(b.kpis.acceptedQuoteValue)).toEqual({ paise: q.accepted, count: q.acceptedCount });
    expect(value(b.kpis.newLeads)).toBe((await directCounts(WS_B)).newLeads);
    expect(value(b.needsYou).find((i) => i.id === 'openCallRequests')?.count).toBe(1);
  });

  it('refuses a non-USER context (404)', async () => {
    await expect(loadClientCommandCenter(await ctxFor(h, 'employee', { workspaceSlug: 'smile-avenue-dental' }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(loadClientCommandCenter(await ctxFor(h, 'admin'))).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a failing widget is reported with a reference while the caller still gets the others', async () => {
    const errors: string[] = [];
    const failed = await settleWidget({ correlationId: 'req_abc' }, CLIENT_METRICS.newLeads, async () => {
      throw new Error('SQLITE_BUSY');
    }, (id) => errors.push(id));
    expect(failed).toEqual({ ok: false, reference: 'req_abc' });
    expect(errors).toEqual(['newLeads']);
    expect(await settleWidget({ correlationId: 'req_abc' }, CLIENT_METRICS.newLeads, async () => 3)).toEqual({ ok: true, value: 3 });
  });
});

describe('admin global metrics', () => {
  it('totals and the workspace table equal direct reads per workspace', async () => {
    const m = await loadPlatformMetrics(await ctxFor(h, 'admin'));
    const workspaces = await db.workspace.findMany({ where: { mode: 'DEMO' } });
    expect(m.totals.workspaces.total).toBe(workspaces.length);
    expect(m.workspaces.map((w) => w.slug).sort()).toEqual(workspaces.map((w) => w.slug).sort());

    let pipeline = 0n;
    let accepted = 0n;
    let leads = 0;
    for (const w of m.workspaces) {
      const q = await directQuoteSums(w.id);
      const d = await directCounts(w.id);
      expect(w.pipelineValue).toEqual({ paise: q.pipeline, count: q.pipelineCount });
      expect(w.acceptedQuoteValue).toEqual({ paise: q.accepted, count: q.acceptedCount });
      expect(w.quotesAwaitingApproval).toBe(q.drafts);
      expect(w.leads).toBe(d.leads);
      expect(w.newLeads).toBe(d.newLeads);
      expect(w.openConversations).toBe(d.openConversations);
      const last = await db.auditEvent.findFirst({ where: { workspaceId: w.id }, orderBy: { createdAt: 'desc' } });
      expect(w.lastActivityAt?.toISOString() ?? null).toBe(last?.createdAt.toISOString() ?? null);
      pipeline += q.pipeline;
      accepted += q.accepted;
      leads += d.leads;
    }
    expect(m.totals.pipelineValue.paise).toBe(pipeline);
    expect(m.totals.acceptedQuoteValue.paise).toBe(accepted);
    expect(m.totals.leads).toBe(leads);
    expect(m.workspaces.find((w) => w.id === WS_A)?.pipelineValue.paise).toBe(711_000n);
    expect(m.workspaces.find((w) => w.id === WS_B)?.pipelineValue.paise).toBe(1_234_500n);
    expect(m.totals.confirmedRevenue).toEqual({ available: false, label: 'Confirmed revenue', value: 'Unavailable', reason: 'No payment data' });

    const people = await db.membership.findMany({ where: { workspace: { mode: 'DEMO' } } });
    expect(m.people.owners).toBe(new Set(people.filter((p) => p.role === 'OWNER').map((p) => p.userId)).size);
    expect(m.people.members).toBe(people.filter((p) => p.role === 'MEMBER').length);
    expect(m.people.employees).toBe(await db.user.count({ where: { globalRole: 'EMPLOYEE' } }));
    expect(m.people.superAdmins).toBe(await db.user.count({ where: { globalRole: 'SUPER_ADMIN' } }));
    expect(m.activeAssignments).toBe(await db.employeeAssignment.count({ where: { active: true, workspace: { mode: 'DEMO' } } }));
    for (const def of Object.values(PLATFORM_METRICS)) expect(def.definition.length).toBeGreaterThan(20);
  });

  it('refuses a non-admin context (404)', async () => {
    await expect(loadPlatformMetrics(await ctxFor(h, 'owner'))).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('command center page', () => {
  it('renders the O6 labels, the "As of" time and every KPI with its final value', async () => {
    const runtime = useRuntime(h.db, testConfig('demo'), h.clock);
    try {
      const { token } = await createSession(h.db, { userId: seedId('user', 'owner'), globalRole: 'USER', mode: 'DEMO', activeWorkspaceId: null, ipHash: 'x', userAgent: 'vitest', now: NOW });
      pageHeaders.current = new Headers({ cookie: `${sessionCookieName(runtime.config)}=${token}` });
      const { default: UserHomePage } = await import('@/app/dashboard/user/page');
      const markup = renderToStaticMarkup(createElement(CsrfProvider as unknown as FC<{ token: string }>, { token: 'csrf' }, (await UserHomePage()) as ReactElement));
      const text = markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      expect(text).toContain('Accepted quote value');
      expect(text).toContain('₹16,500.00');
      expect(text).toContain('Pipeline value');
      expect(text).toContain('₹7,110.00');
      expect(text).toMatch(/Confirmed revenue Unavailable/);
      expect(text).toContain('No payment data');
      expect(text).toMatch(/As of \d{1,2} Oct 2026/);
      expect(text).toContain('Needs you');
      expect(text).not.toMatch(/count-?up/i);
    } finally {
      uninstallRuntime();
    }
  });
});
