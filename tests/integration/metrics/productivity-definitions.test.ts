/**
 * T25 / P10: employee productivity is read from the audit trail, per employee and per period, and
 * every metric carries a visible definition string. There is no composite score: the result has
 * exactly the five named metrics (lead actions, approvals decided, median time to decision, sends
 * queued, accepted quotes attributed to the last approver), nothing that ranks or combines them.
 *  - Only successful actions by the employee inside the period count; other actors, DENIED rows
 *    and rows before the period do not.
 *  - The median time to decision is wall clock (requestedAt -> decision) over the employee's
 *    decisions, null when there were none.
 *  - An acceptance is attributed to whoever last approved the accepted version.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { NotFoundError } from '@/lib/errors';
import { LEAD_STAGE_ACTION_PREFIX, loadProductivity, PRODUCTIVITY_METRICS, PRODUCTIVITY_PERIODS, type ProductivityRow } from '@/server/services/metrics/productivity';
import { ago, createMetricsHarness, ctxFor, DAY, destroyHarness, EMPLOYEE, insertApproval, insertAudit, insertQuote, NEHA, OWNER_A, WS_A, WS_B, type MetricsHarness } from './support';

let h: MetricsHarness;
let db: PrismaClient;
const HOUR = 3_600_000;

beforeAll(async () => {
  h = await createMetricsHarness('metrics-productivity');
  db = h.db;

  // Imran (EMPLOYEE): lead actions in and out of the period, one DENIED, one by the owner.
  await insertAudit(db, { actorUserId: EMPLOYEE, action: `${LEAD_STAGE_ACTION_PREFIX}.move`, createdAt: ago(DAY) });
  await insertAudit(db, { actorUserId: EMPLOYEE, action: `${LEAD_STAGE_ACTION_PREFIX}.move`, createdAt: ago(2 * DAY) });
  await insertAudit(db, { actorUserId: EMPLOYEE, action: 'ai.draft.request', createdAt: ago(3 * DAY) });
  await insertAudit(db, { actorUserId: EMPLOYEE, action: 'ai.draft.request', createdAt: ago(20 * DAY) }); // only in 30 days
  await insertAudit(db, { actorUserId: EMPLOYEE, action: 'ai.draft.request', result: 'DENIED', createdAt: ago(DAY) });
  await insertAudit(db, { actorUserId: OWNER_A, actorKind: 'USER', action: 'ai.draft.request', createdAt: ago(DAY) });

  // Decisions: Imran approves after 2 h and rejects after 6 h; Neha approves after 1 h (workspace B).
  const q1 = await insertQuote(db, { status: 'APPROVED', totals: [100_000n] });
  const a1 = await insertApproval(db, { kind: 'QUOTE_VERSION', status: 'APPROVED', quoteId: q1.quote.id, quoteVersionId: q1.versionId, requestedAt: ago(DAY + 2 * HOUR), decidedBy: EMPLOYEE, decidedAt: ago(DAY) });
  await insertAudit(db, { actorUserId: EMPLOYEE, action: 'quote.approve', targetType: 'Quote', targetId: q1.quote.id, summary: { versionNo: 1, approvalId: a1.id }, createdAt: ago(DAY) });
  const a2 = await insertApproval(db, { kind: 'OUTBOUND_MESSAGE', status: 'REJECTED', requestedAt: ago(2 * DAY + 6 * HOUR), decidedBy: EMPLOYEE, decidedAt: ago(2 * DAY) });
  await insertAudit(db, { actorUserId: EMPLOYEE, action: 'approval.reject', targetType: 'Approval', targetId: a2.id, summary: { kind: 'OUTBOUND_MESSAGE' }, createdAt: ago(2 * DAY) });
  const qb = await insertQuote(db, { workspaceId: WS_B, status: 'APPROVED', totals: [10_000n] });
  const ab = await insertApproval(db, { workspaceId: WS_B, kind: 'QUOTE_VERSION', status: 'APPROVED', quoteId: qb.quote.id, quoteVersionId: qb.versionId, requestedAt: ago(DAY + HOUR), decidedBy: NEHA, decidedAt: ago(DAY) });
  await insertAudit(db, { workspaceId: WS_B, actorUserId: NEHA, action: 'quote.approve', targetType: 'Quote', targetId: qb.quote.id, summary: { versionNo: 1, approvalId: ab.id }, createdAt: ago(DAY) });

  // Sends queued by Imran (two), and one by the owner.
  await insertAudit(db, { actorUserId: EMPLOYEE, action: 'dispatch.queue', targetType: 'Message', createdAt: ago(HOUR) });
  await insertAudit(db, { actorUserId: EMPLOYEE, action: 'dispatch.queue', targetType: 'Quote', createdAt: ago(5 * DAY) });
  await insertAudit(db, { actorUserId: OWNER_A, actorKind: 'USER', action: 'dispatch.queue', targetType: 'Message', createdAt: ago(HOUR) });

  // Acceptances: q2 v1 approved by the owner, then v2 approved by Imran, v2 accepted -> Imran.
  // q3 approved by Neha, accepted 40 days ago -> outside both periods.
  const q2 = await insertQuote(db, { status: 'ACCEPTED', totals: [50_000n, 60_000n] });
  await insertAudit(db, { actorUserId: OWNER_A, actorKind: 'USER', action: 'quote.approve', targetType: 'Quote', targetId: q2.quote.id, summary: { versionNo: 1 }, createdAt: ago(6 * DAY) });
  await insertAudit(db, { actorUserId: EMPLOYEE, action: 'quote.approve', targetType: 'Quote', targetId: q2.quote.id, summary: { versionNo: 2 }, createdAt: ago(4 * DAY) });
  await insertAudit(db, { actorKind: 'PUBLIC', action: 'quote.accept', targetType: 'Quote', targetId: q2.quote.id, summary: { versionNo: 2 }, createdAt: ago(3 * DAY) });
  const q3 = await insertQuote(db, { workspaceId: WS_B, status: 'ACCEPTED', totals: [70_000n] });
  await insertAudit(db, { workspaceId: WS_B, actorUserId: NEHA, action: 'quote.approve', targetType: 'Quote', targetId: q3.quote.id, summary: { versionNo: 1 }, createdAt: ago(45 * DAY) });
  await insertAudit(db, { workspaceId: WS_B, actorKind: 'PUBLIC', action: 'quote.accept', targetType: 'Quote', targetId: q3.quote.id, summary: { versionNo: 1 }, createdAt: ago(40 * DAY) });
  void WS_A;
});

afterAll(async () => {
  await destroyHarness(h);
});

const row = (rows: ProductivityRow[], userId: string) => {
  const r = rows.find((x) => x.userId === userId);
  if (!r) throw new Error(`no row for ${userId}`);
  return r;
};

describe('P10 definitions', () => {
  it('has exactly five named metrics, each with a definition string, and no composite score', async () => {
    expect(PRODUCTIVITY_METRICS.map((m) => m.id)).toEqual(['leadsProcessed', 'approvalsDecided', 'medianTimeToDecision', 'messagesDispatched', 'quotesAcceptedAttributed']);
    for (const m of PRODUCTIVITY_METRICS) {
      expect(m.label.length).toBeGreaterThan(3);
      expect(m.definition.length).toBeGreaterThan(40);
      expect(m.source).toMatch(/AuditEvent|Approval/);
    }
    expect(PRODUCTIVITY_METRICS.find((m) => m.id === 'medianTimeToDecision')!.definition).toMatch(/wall.clock/i);

    const result = await loadProductivity(await ctxFor(h, 'admin'), { days: 7 });
    const keys = Object.keys(result.rows[0]!).sort();
    expect(keys).toEqual(['activeAssignments', 'approvalsDecided', 'decisionsTimed', 'leadsProcessed', 'medianTimeToDecisionMs', 'messagesDispatched', 'name', 'quotesAcceptedAttributed', 'status', 'userId'].sort());
    for (const k of keys) expect(k).not.toMatch(/score|efficien|rank|index|total/i);
    expect(result.definitions).toBe(PRODUCTIVITY_METRICS);
    expect(PRODUCTIVITY_PERIODS).toEqual([7, 30]);
  });
});

describe('P10 metrics from the audit trail', () => {
  it('counts each employee\'s successful actions inside the last 7 days only', async () => {
    const r = await loadProductivity(await ctxFor(h, 'admin'), { days: 7 });
    expect(r.days).toBe(7);
    expect(r.since.toISOString()).toBe(ago(7 * DAY).toISOString());
    const employees = await db.user.findMany({ where: { globalRole: 'EMPLOYEE' } });
    expect(r.rows.map((x) => x.userId).sort()).toEqual(employees.map((e) => e.id).sort());

    const imran = row(r.rows, EMPLOYEE);
    const direct = async (actions: { in?: string[]; startsWith?: string }, userId: string, since: Date) =>
      db.auditEvent.count({ where: { actorUserId: userId, result: 'SUCCESS', createdAt: { gte: since }, action: actions.in ? { in: actions.in } : { startsWith: actions.startsWith! } } });
    const since = ago(7 * DAY);
    expect(imran.leadsProcessed).toBe((await direct({ startsWith: LEAD_STAGE_ACTION_PREFIX }, EMPLOYEE, since)) + (await direct({ in: ['ai.draft.request'] }, EMPLOYEE, since)));
    expect(imran.leadsProcessed).toBe(3);
    expect(imran.approvalsDecided).toBe(await direct({ in: ['quote.approve', 'approval.reject'] }, EMPLOYEE, since));
    expect(imran.approvalsDecided).toBe(3); // a1, the reject, and v2 of q2
    expect(imran.messagesDispatched).toBe(await direct({ in: ['dispatch.queue'] }, EMPLOYEE, since));
    expect(imran.messagesDispatched).toBe(2);
    expect(imran.quotesAcceptedAttributed).toBe(1);
    expect(imran.activeAssignments).toBe(await db.employeeAssignment.count({ where: { employeeUserId: EMPLOYEE, active: true } }));

    const neha = row(r.rows, NEHA);
    expect(neha).toMatchObject({ leadsProcessed: 0, approvalsDecided: 1, messagesDispatched: 0, quotesAcceptedAttributed: 0, medianTimeToDecisionMs: HOUR, decisionsTimed: 1 });
    const arjun = row(r.rows, (await db.user.findFirstOrThrow({ where: { email: { startsWith: 'arjun.' } } })).id);
    expect(arjun).toMatchObject({ leadsProcessed: 0, approvalsDecided: 0, medianTimeToDecisionMs: null, decisionsTimed: 0, messagesDispatched: 0, quotesAcceptedAttributed: 0 });
  });

  it('median time to decision is wall clock from the request to the decision', async () => {
    const r = await loadProductivity(await ctxFor(h, 'admin'), { days: 7 });
    const imran = row(r.rows, EMPLOYEE);
    // Timed decisions: a1 (2 h) and the reject (6 h). The q2 v2 approval names no approval id, so it is counted but not timed.
    expect(imran.decisionsTimed).toBe(2);
    expect(imran.medianTimeToDecisionMs).toBe(4 * HOUR);
  });

  it('the 30-day period includes the older rows and acceptances stay attributed to the last approver', async () => {
    const r = await loadProductivity(await ctxFor(h, 'admin'), { days: 30 });
    expect(row(r.rows, EMPLOYEE).leadsProcessed).toBe(4);
    expect(row(r.rows, NEHA).quotesAcceptedAttributed).toBe(0); // accepted 40 days ago
    const r90 = await loadProductivity(await ctxFor(h, 'admin'), { days: 30 });
    expect(r90.days).toBe(30);
  });

  it('only the platform admin may read it (404 otherwise), and an unknown period falls back to 7 days', async () => {
    await expect(loadProductivity(await ctxFor(h, 'owner'), { days: 7 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(loadProductivity(await ctxFor(h, 'employee', { workspaceSlug: 'smile-avenue-dental' }), { days: 7 })).rejects.toBeInstanceOf(NotFoundError);
    const r = await loadProductivity(await ctxFor(h, 'admin'), { days: 12 });
    expect(r.days).toBe(7);
  });
});
