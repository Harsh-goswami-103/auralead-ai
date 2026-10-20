/**
 * T25: each dashboard load stays under 15 SQL statements, counted at the driver adapter (so a
 * relation include that Prisma splits into two statements counts twice). The count covers the
 * dashboard's whole read model: the client command center, the admin global metrics (platform
 * health, accounts and the workspace table) and the productivity page. The context build (session
 * load) happens before counting starts, exactly as the page does it before calling the loader.
 * The budget must not grow with the data: more leads, quotes, workspaces and audit rows give the
 * same statement count (no per-row queries). Lookups that only resolve ids found by an earlier
 * statement (actor names, approval request times) are skipped when there is nothing to resolve,
 * so the baseline already has rows of every kind.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadClientCommandCenter } from '@/server/services/metrics/command-center';
import { loadPlatformMetrics } from '@/server/services/metrics/platform';
import { loadProductivity } from '@/server/services/metrics/productivity';
import { ago, createMetricsHarness, ctxFor, DAY, destroyHarness, EMPLOYEE, insertApproval, insertAudit, insertConversation, insertLead, insertQuote, WS_B, type MetricsHarness } from './support';

const BUDGET = 15;
let h: MetricsHarness;

beforeAll(async () => {
  h = await createMetricsHarness('metrics-query-budget');
  // A baseline with rows in every widget, so later growth adds rows, never new kinds of row.
  await addData(2);
});
afterAll(async () => {
  await destroyHarness(h);
});

async function measure(run: () => Promise<unknown>): Promise<{ count: number; sql: string[] }> {
  h.counter.reset();
  await run();
  return { count: h.counter.count, sql: [...h.counter.sql] };
}

async function addData(n: number) {
  for (let i = 0; i < n; i++) {
    await insertLead(h.db, { createdAt: ago(i * DAY) });
    await insertQuote(h.db, { status: i % 2 === 0 ? 'SENT' : 'ACCEPTED', totals: [10_000n * BigInt(i + 1)] });
    await insertQuote(h.db, { workspaceId: WS_B, status: 'VIEWED', totals: [5_000n] });
    await insertConversation(h.db, { takeover: i % 3 === 0 });
    await insertAudit(h.db, { actorUserId: EMPLOYEE, action: 'dispatch.queue', createdAt: ago(i * 3_600_000) });
    const accepted = await insertQuote(h.db, { status: 'ACCEPTED', totals: [20_000n] });
    await insertAudit(h.db, { actorUserId: EMPLOYEE, action: 'quote.approve', targetType: 'Quote', targetId: accepted.quote.id, summary: { versionNo: 1 }, createdAt: ago(i * 3_600_000 + 60_000) });
    await insertAudit(h.db, { actorKind: 'PUBLIC', action: 'quote.accept', targetType: 'Quote', targetId: accepted.quote.id, summary: { versionNo: 1 }, createdAt: ago(i * 3_600_000) });
    const rejected = await insertApproval(h.db, { kind: 'OUTBOUND_MESSAGE', status: 'REJECTED', decidedBy: EMPLOYEE, decidedAt: ago(i * 3_600_000) });
    await insertAudit(h.db, { actorUserId: EMPLOYEE, action: 'approval.reject', targetType: 'Approval', targetId: rejected.id, createdAt: ago(i * 3_600_000) });
  }
}

describe('dashboard query budget', () => {
  it(`client command center: fewer than ${BUDGET} statements, independent of data size`, async () => {
    const ctx = await ctxFor(h, 'owner', { client: h.counting });
    const before = await measure(() => loadClientCommandCenter(ctx));
    expect(before.count, before.sql.join('\n')).toBeLessThan(BUDGET);
    await addData(12);
    const after = await measure(() => loadClientCommandCenter(ctx));
    expect(after.count, after.sql.join('\n')).toBe(before.count);
  });

  it(`admin global metrics: fewer than ${BUDGET} statements, independent of data size`, async () => {
    const ctx = await ctxFor(h, 'admin', { client: h.counting });
    const before = await measure(() => loadPlatformMetrics(ctx, { envOutboundPaused: false, lockFile: '/nonexistent/auralead/outbound.lock' }));
    expect(before.count, before.sql.join('\n')).toBeLessThan(BUDGET);
    for (let i = 0; i < 4; i++) {
      await h.db.workspace.create({ data: { slug: `budget-${i}`, name: `Budget ${i}`, mode: 'DEMO', planLabel: 'Starter' } });
    }
    await addData(6);
    const after = await measure(() => loadPlatformMetrics(ctx, { envOutboundPaused: false, lockFile: '/nonexistent/auralead/outbound.lock' }));
    expect(after.count, after.sql.join('\n')).toBe(before.count);
  });

  it(`productivity: fewer than ${BUDGET} statements, independent of data size`, async () => {
    const ctx = await ctxFor(h, 'admin', { client: h.counting });
    const before = await measure(() => loadProductivity(ctx, { days: 30 }));
    expect(before.count, before.sql.join('\n')).toBeLessThan(BUDGET);
    await addData(6);
    const after = await measure(() => loadProductivity(ctx, { days: 30 }));
    expect(after.count, after.sql.join('\n')).toBe(before.count);
  });
});
