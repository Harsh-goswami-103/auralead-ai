/**
 * AT12 (approve-and-send, plan §4.4, §6.3, E4): ten concurrent approve-and-send calls from two
 * separate DB clients (two "processes" contending on the SQLite write lock) give one Approval, one
 * Job, one Message and one attempt; every caller gets the same ids. The send is version-bound,
 * persists sendIntent and initiatedBy on Message and attempt, and settles the quote to SENT.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildUserContext } from '@/server/auth/context';
import { createSession, loadSession } from '@/server/auth/session';
import { approveAndSendQuote } from '@/server/services/messaging/dispatch';
import { approvedTemplate, createDispatchHarness, DEPS, eligibleLead, OWNER_ID, quoteWithPdf, WS_A, type DispatchHarness } from './support';
import type { PrismaClient } from '@/generated/prisma/client';
import type { FixedClock } from '@/lib/clock';

let h: DispatchHarness;
beforeAll(async () => {
  h = await createDispatchHarness('approve-send');
}, 120_000);
afterAll(async () => h?.destroy());

async function ownerOn(db: PrismaClient, clock: FixedClock, n: number) {
  const user = await db.user.findUniqueOrThrow({ where: { id: OWNER_ID } });
  const { token } = await createSession(db, { userId: OWNER_ID, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: WS_A, ipHash: 'x', userAgent: 'vitest', now: clock.now() });
  const loaded = (await loadSession(db, token, { now: clock.now(), mode: 'DEMO' }))!;
  return buildUserContext(loaded, { prisma: db, mode: 'demo', clock }, { correlationId: `req_aas_${n}` });
}

describe('approve-and-send (AT12)', () => {
  it('10 concurrent calls from 2 clients create exactly one approval, job, message and attempt', async () => {
    const lead = await eligibleLead(h.db);
    const template = await approvedTemplate(h.db);
    const { quote } = await quoteWithPdf(h, lead.id);
    const second = h.testDb.client();
    const ctxs = await Promise.all(Array.from({ length: 10 }, (_, i) => ownerOn(i % 2 === 0 ? h.db : second, h.clock, i)));

    const results = await Promise.all(
      ctxs.map((ctx) => approveAndSendQuote(ctx, { quoteId: quote.id, expectedVersion: 1, channel: 'WHATSAPP', templateId: template.id, variables: { '1': 'Asha' } }, DEPS)),
    );
    const first = results[0]!;
    for (const r of results) expect({ ...r, created: undefined }).toEqual({ ...first, created: undefined });
    expect(results.filter((r) => r.created)).toHaveLength(1);

    expect(await h.db.approval.count({ where: { quoteId: quote.id } })).toBe(1);
    const approval = await h.db.approval.findUniqueOrThrow({ where: { id: first.approvalId } });
    expect(approval).toMatchObject({ status: 'APPROVED', kind: 'QUOTE_VERSION', messageId: first.messageId, decidedBy: OWNER_ID });
    expect(approval.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await h.db.job.count({ where: { type: 'dispatch.whatsapp' } })).toBe(1);
    expect(await h.db.message.count({ where: { direction: 'OUT', conversation: { leadId: lead.id } } })).toBe(1);
    expect(await h.db.dispatchAttempt.count({ where: { messageId: first.messageId } })).toBe(1);
    expect(await h.db.auditEvent.count({ where: { action: 'quote.approve', targetId: quote.id } })).toBe(1);

    const message = await h.db.message.findUniqueOrThrow({ where: { id: first.messageId } });
    const attempt = await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: first.attemptId } });
    const version = await h.db.quoteVersion.findFirstOrThrow({ where: { quoteId: quote.id, versionNo: 1 } });
    expect(message).toMatchObject({ status: 'PENDING', sendIntent: 'MANUAL_SINGLE', initiatedBy: OWNER_ID, quoteVersionId: version.id, simulated: true });
    expect(attempt).toMatchObject({ state: 'QUEUED', sendIntent: 'MANUAL_SINGLE', initiatedBy: OWNER_ID, quoteVersionId: version.id, approvalId: first.approvalId, attemptNo: 1 });
    const job = await h.db.job.findUniqueOrThrow({ where: { id: first.jobId } });
    expect(job.serialKey).toBe(message.conversationId);
    expect((await h.db.quote.findUniqueOrThrow({ where: { id: quote.id } })).status).toBe('APPROVED');

    // The worker sends once and settles: SENT with the provider id, quote SENT, lead QUOTE_SENT.
    await h.drain();
    expect(h.wa.calls).toHaveLength(1);
    expect(h.wa.calls[0]!.request).toMatchObject({ kind: 'template', template: { name: template.name, variables: { '1': 'Asha' } }, to: lead.phoneE164 });
    expect(h.wa.calls[0]!.request.document?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: first.attemptId } })).toMatchObject({ state: 'SENT', providerMessageId: `prov.${first.attemptId}` });
    expect(await h.db.message.findUniqueOrThrow({ where: { id: first.messageId } })).toMatchObject({ status: 'SENT', statusRank: 1 });
    expect(await h.db.quote.findUniqueOrThrow({ where: { id: quote.id } })).toMatchObject({ status: 'SENT', sentVia: 'DISPATCH' });
    expect((await h.db.quoteVersion.findUniqueOrThrow({ where: { id: version.id } })).sentAt).not.toBeNull();
    expect((await h.db.lead.findUniqueOrThrow({ where: { id: lead.id } })).salesStage).toBe('QUOTE_SENT');
    expect(await h.db.job.findUniqueOrThrow({ where: { id: first.jobId } })).toMatchObject({ status: 'SUCCEEDED' });

    // A late duplicate click after the send still answers with the same ids and sends nothing.
    const late = await approveAndSendQuote(ctxs[3]!, { quoteId: quote.id, expectedVersion: 1, channel: 'WHATSAPP', templateId: template.id }, DEPS);
    expect(late).toEqual({ ...first, created: false });
    await h.drain();
    expect(h.wa.calls).toHaveLength(1);
  }, 120_000);

  it('a stale expected version is 409 and creates nothing', async () => {
    const lead = await eligibleLead(h.db);
    const { quote } = await quoteWithPdf(h, lead.id);
    const ctx = await h.owner();
    await expect(approveAndSendQuote(ctx, { quoteId: quote.id, expectedVersion: 2, channel: 'EMAIL' }, DEPS)).rejects.toMatchObject({ status: 409 });
    expect(await h.db.dispatchAttempt.count({ where: { quoteVersion: { quoteId: quote.id } } })).toBe(0);
    expect((await h.db.quote.findUniqueOrThrow({ where: { id: quote.id } })).status).toBe('DRAFT');
  }, 60_000);

  it('email approve-and-send carries the PDF, the unsubscribe link and List-Unsubscribe headers', async () => {
    const lead = await eligibleLead(h.db);
    const { quote } = await quoteWithPdf(h, lead.id);
    const ctx = await h.owner();
    const r = await approveAndSendQuote(ctx, { quoteId: quote.id, expectedVersion: 1, channel: 'EMAIL' }, DEPS);
    const before = h.email.calls.length;
    await h.drain();
    expect(h.email.calls).toHaveLength(before + 1);
    const sent = h.email.calls.at(-1)!.request;
    expect(sent.to).toBe(lead.emailNormalized);
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments[0]!.filename).toMatch(/^Q-\d{4}-v1\.pdf$/);
    expect(sent.headers['List-Unsubscribe']).toMatch(/^<http:\/\/localhost:3000\/api\/unsubscribe\?token=/);
    expect(sent.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(sent.text).toContain('/unsubscribe/');
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: r.attemptId } })).toMatchObject({ state: 'SENT' });
  }, 60_000);

  it('a WhatsApp quotation without a template is refused before anything is written', async () => {
    const lead = await eligibleLead(h.db);
    const { quote } = await quoteWithPdf(h, lead.id);
    await expect(approveAndSendQuote(await h.owner(), { quoteId: quote.id, expectedVersion: 1, channel: 'WHATSAPP' }, DEPS)).rejects.toMatchObject({ code: 'TEMPLATE_REQUIRED' });
    expect((await h.db.quote.findUniqueOrThrow({ where: { id: quote.id } })).status).toBe('DRAFT');
  }, 60_000);
});
