// T22 approval queue (R32, AT12 at the queue, 06-design F18): the queue lists PENDING quote-version
// and message approvals oldest first; an item shows the version diff and per-channel eligibility from
// the shared dispatch eligibility function; approve and approve-and-send bind the version on screen
// (a stale tab gets 409 APPROVAL_CHANGED, "This item changed since you opened it"); concurrent
// approve-and-send calls create one dispatch; an employee's edit above their own discount cap is 403;
// reject closes the item (a message draft becomes NOT_SENT) and is audited; other workspaces are 404.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedId } from '../../../prisma/seed/ids';
import { createMessageDraft } from '@/server/services/messaging/dispatch';
import { approveFromQueue, getApprovalItem, listApprovalQueue, rejectApproval, reviseFromQueue, sendFromQueue } from '@/server/services/approvals/queue';
import { userCtx } from '../quotes/support';
import { approvedTemplate, createDispatchHarness, DEPS, eligibleLead, grantConsent, createLead, quoteWithPdf, type DispatchHarness } from '../dispatch/support';

let h: DispatchHarness;
const QDEPS = { ...DEPS, externalOutboundPause: false };
const WS_SLUG = 'smile-avenue-dental';
const ALIGN = seedId('service', `${WS_SLUG}:ALIGN`);
const CONSULT = seedId('service', `${WS_SLUG}:CONSULT`);

beforeAll(async () => {
  h = await createDispatchHarness('approval-queue');
}, 120_000);

afterAll(async () => {
  await h?.destroy();
});

const employee = () => userCtx(h.db, h.clock, 'employee', WS_SLUG);
const content = (qty: number, discount: { kind: 'NONE' | 'PERCENT_BPS'; value: string } = { kind: 'NONE', value: '0' }) => ({
  items: [{ serviceId: CONSULT, qty }],
  discount,
  scopeText: 'Consultation and plan.',
  timelineText: 'One visit',
});

describe('approval queue', () => {
  it('lists the pending quote version with its PDF state and channel eligibility', async () => {
    const lead = await eligibleLead(h.db);
    const { quote } = await quoteWithPdf(h, lead.id);
    const ctx = await employee();
    const queue = await listApprovalQueue(ctx);
    const item = queue.pending.find((i) => i.quote?.id === quote.id);
    expect(item).toMatchObject({ kind: 'QUOTE_VERSION', status: 'PENDING', lead: { id: lead.id }, quote: { number: quote.number, versionNo: 1, isCurrent: true, pdfReady: true } });
    expect(queue.permissions).toMatchObject({ canDecide: true, canSend: true, canEdit: true });

    const detail = await getApprovalItem(ctx, item!.id, QDEPS);
    const email = detail.channels.find((c) => c.channel === 'EMAIL');
    expect(email).toMatchObject({ gate: null, eligibility: { eligible: true, reasons: [] } });
    const wa = detail.channels.find((c) => c.channel === 'WHATSAPP');
    expect(wa!.gate).toMatchObject({ category: 'configuration' });
    expect(detail.diff).toBeNull();
  });

  it('a stale tab cannot approve an older version (409 APPROVAL_CHANGED); the new item shows the diff', async () => {
    const lead = await eligibleLead(h.db);
    const { quote } = await quoteWithPdf(h, lead.id);
    const ctx = await employee();
    const first = (await listApprovalQueue(ctx)).pending.find((i) => i.quote?.id === quote.id)!;
    await reviseFromQueue(ctx, first.id, { expectedVersion: 1, ...content(2) });
    await expect(approveFromQueue(ctx, first.id, { expectedVersion: 1 })).rejects.toMatchObject({ status: 409, code: 'APPROVAL_CHANGED', userMessage: expect.stringContaining('changed since you opened it') });
    await expect(sendFromQueue(ctx, first.id, { expectedVersion: 1, channel: 'EMAIL' }, QDEPS)).rejects.toMatchObject({ status: 409, code: 'APPROVAL_CHANGED' });

    const second = (await listApprovalQueue(ctx)).pending.find((i) => i.quote?.id === quote.id)!;
    expect(second.quote).toMatchObject({ versionNo: 2, isCurrent: true });
    const detail = await getApprovalItem(ctx, second.id, QDEPS);
    expect(detail.diff).toMatchObject({ fromVersionNo: 1, toVersionNo: 2 });
    expect(detail.diff!.previousApproval).toBe('INVALIDATED');
    const line = detail.diff!.lines.find((l) => l.serviceId === CONSULT)!;
    expect(line).toMatchObject({ change: 'CHANGED', fromQty: 1, toQty: 2 });
    expect(detail.diff!.totals.to).not.toBe(detail.diff!.totals.from);

    // Approve the version on screen: the quote is APPROVED, the item leaves the pending list.
    const approved = await approveFromQueue(ctx, second.id, { expectedVersion: 2 });
    expect(approved).toMatchObject({ status: 'APPROVED' });
    expect((await listApprovalQueue(ctx)).pending.some((i) => i.id === second.id)).toBe(false);
  });

  it('an employee edit above their own discount cap is 403 and saves nothing; within it a new version', async () => {
    const lead = await eligibleLead(h.db);
    const { quote } = await quoteWithPdf(h, lead.id);
    const ctx = await employee();
    const item = (await listApprovalQueue(ctx)).pending.find((i) => i.quote?.id === quote.id)!;
    const over = { expectedVersion: 1, items: [{ serviceId: ALIGN, qty: 1 }], discount: { kind: 'PERCENT_BPS' as const, value: '1200' }, scopeText: 'Aligners', timelineText: 'Six months' };
    await expect(reviseFromQueue(ctx, item.id, over)).rejects.toMatchObject({ status: 403, code: 'DISCOUNT_OVER_ACTOR_CAP' });
    expect((await h.db.quote.findFirstOrThrow({ where: { id: quote.id } })).currentVersionNo).toBe(1);
    const within = await reviseFromQueue(ctx, item.id, { ...over, discount: { kind: 'PERCENT_BPS', value: '1000' } });
    expect(within.version.versionNo).toBe(2);
  });

  it('concurrent approve-and-send calls create one dispatch and return the same ids', async () => {
    const lead = await eligibleLead(h.db);
    const { quote } = await quoteWithPdf(h, lead.id);
    const ctx = await employee();
    const item = (await listApprovalQueue(ctx)).pending.find((i) => i.quote?.id === quote.id)!;
    const results = await Promise.all(Array.from({ length: 5 }, () => sendFromQueue(ctx, item.id, { expectedVersion: 1, channel: 'EMAIL' }, QDEPS)));
    expect(new Set(results.map((r) => r.attemptId)).size).toBe(1);
    expect(new Set(results.map((r) => r.jobId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    // A later programmatic retry still answers the same ids.
    const retry = await sendFromQueue(ctx, item.id, { expectedVersion: 1, channel: 'EMAIL' }, QDEPS);
    expect(retry.attemptId).toBe(results[0]!.attemptId);
    expect(await h.db.dispatchAttempt.count({ where: { quoteVersion: { quoteId: quote.id } } })).toBe(1);
    await h.drain();
    const queue = await listApprovalQueue(ctx);
    const recent = queue.recent.find((i) => i.quote?.id === quote.id);
    expect(recent).toMatchObject({ status: 'APPROVED', dispatch: { state: 'SENT' } });
  });

  it('a WhatsApp quote send needs a template; with an approved one the channel is offered', async () => {
    const lead = await eligibleLead(h.db);
    const { quote } = await quoteWithPdf(h, lead.id);
    const template = await approvedTemplate(h.db);
    const ctx = await employee();
    const item = (await listApprovalQueue(ctx)).pending.find((i) => i.quote?.id === quote.id)!;
    const detail = await getApprovalItem(ctx, item.id, QDEPS);
    const wa = detail.channels.find((c) => c.channel === 'WHATSAPP')!;
    expect(wa.gate).toBeNull();
    expect(wa.templates.map((t) => t.id)).toContain(template.id);
    await expect(sendFromQueue(ctx, item.id, { expectedVersion: 1, channel: 'WHATSAPP' }, QDEPS)).rejects.toMatchObject({ status: 400, code: 'TEMPLATE_REQUIRED' });
  });

  it('reject closes a message draft (NOT_SENT), is audited, and a second decision is 409', async () => {
    const lead = await createLead(h.db);
    await grantConsent(h.db, lead, 'EMAIL');
    const owner = await h.owner();
    const draft = await createMessageDraft(owner, { leadId: lead.id, channel: 'EMAIL', kind: 'EMAIL', subject: 'Hello', body: 'A short note.' }, DEPS);
    const ctx = await employee();
    const item = (await listApprovalQueue(ctx)).pending.find((i) => i.id === draft.approvalId);
    expect(item).toMatchObject({ kind: 'OUTBOUND_MESSAGE', message: { id: draft.messageId, channel: 'EMAIL', subject: 'Hello' } });
    const rejected = await rejectApproval(ctx, { approvalId: draft.approvalId, reason: 'Wrong tone for this lead' });
    expect(rejected).toMatchObject({ status: 'REJECTED' });
    expect(await h.db.message.findFirstOrThrow({ where: { id: draft.messageId } })).toMatchObject({ status: 'NOT_SENT' });
    expect(await h.db.auditEvent.count({ where: { action: 'approval.reject', targetId: draft.approvalId } })).toBe(1);
    await expect(rejectApproval(ctx, { approvalId: draft.approvalId, reason: 'again please' })).rejects.toMatchObject({ status: 409, code: 'APPROVAL_CHANGED' });
    await expect(sendFromQueue(ctx, draft.approvalId, {}, QDEPS)).rejects.toMatchObject({ status: 409 });
  });

  it('message drafts are approved and sent in one step; a workspace B approval is 404', async () => {
    const lead = await createLead(h.db);
    await grantConsent(h.db, lead, 'EMAIL');
    const owner = await h.owner();
    const draft = await createMessageDraft(owner, { leadId: lead.id, channel: 'EMAIL', kind: 'EMAIL', subject: 'Visit reminder', body: 'See you on Friday.' }, DEPS);
    const ctx = await employee();
    await expect(approveFromQueue(ctx, draft.approvalId, { expectedVersion: 1 })).rejects.toMatchObject({ status: 422, code: 'SEND_TO_APPROVE' });
    const sent = await sendFromQueue(ctx, draft.approvalId, {}, QDEPS);
    expect(sent).toMatchObject({ messageId: draft.messageId, created: true });
    const wsB = await h.db.approval.findFirstOrThrow({ where: { workspaceId: seedId('workspace', 'ironpulse-fitness') } });
    await expect(getApprovalItem(ctx, wsB.id, QDEPS)).rejects.toMatchObject({ status: 404 });
    await expect(rejectApproval(ctx, { approvalId: wsB.id, reason: 'not mine at all' })).rejects.toMatchObject({ status: 404 });
  });

  it('a reader without approvals.decide sees the queue read-only and cannot decide (403)', async () => {
    const neha = await userCtx(h.db, h.clock, 'neha', 'ironpulse-fitness');
    const queue = await listApprovalQueue(neha);
    expect(queue.permissions).toMatchObject({ canDecide: false, canSend: false, canEdit: false });
    const item = queue.pending[0]!;
    await expect(rejectApproval(neha, { approvalId: item.id, reason: 'no permission here' })).rejects.toMatchObject({ status: 403 });
  });
});
