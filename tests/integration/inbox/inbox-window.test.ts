// Adversarial review: the inbox lists the 200 most recently active threads, but its counts and its
// "Needs you" / "Handed over" filters are computed over every open thread. A customer who answered
// in an older thread (created before 200 newer ones, e.g. after a bulk template send) must not vanish.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INBOX_THREAD_LIMIT, listInboxThreads } from '@/server/services/messaging/inbox';
import { userCtx } from '../quotes/support';
import { createLead } from '../dispatch/support';
import { createInboundHarness, WS_A, type InboundHarness } from '../messaging/inbound-support';

let h: InboundHarness;
beforeAll(async () => {
  h = await createInboundHarness('inbox-window');
}, 120_000);
afterAll(async () => h?.destroy());

describe('inbox beyond the newest 200 threads', () => {
  it('keeps old threads that need the operator or were handed over in their filters, and counts every open thread', async () => {
    const base = h.clock.now().getTime();
    const oldNeeds = await createLead(h.db);
    const oldHanded = await createLead(h.db);
    const old = [oldNeeds, oldHanded];
    for (const [i, lead] of old.entries()) {
      await h.db.conversation.create({ data: { workspaceId: WS_A, leadId: lead.id, channel: 'WHATSAPP', contactKey: `ck-old-${i}`, createdAt: new Date(base - 10 * 86_400_000 + i) } });
    }
    const oldConversation = await h.db.conversation.findFirstOrThrow({ where: { leadId: oldNeeds.id } });
    await h.db.callRequest.create({ data: { workspaceId: WS_A, leadId: oldNeeds.id, conversationId: oldConversation.id, source: 'QUICK_REPLY', requestedAt: new Date(base) } });
    await h.db.lead.update({ where: { id: oldHanded.id }, data: { handedOverAt: new Date(base) } });

    const fresh = INBOX_THREAD_LIMIT + 5;
    const leads = [];
    for (let i = 0; i < fresh; i += 1) leads.push(await createLead(h.db));
    await h.db.conversation.createMany({ data: leads.map((l, i) => ({ workspaceId: WS_A, leadId: l.id, channel: 'WHATSAPP' as const, contactKey: `ck-new-${i}`, createdAt: new Date(base - 60_000 + i) })) });

    const ctx = await userCtx(h.db, h.clock, 'owner', 'smile-avenue-dental');
    const all = await listInboxThreads(ctx, {});
    expect(all.rows).toHaveLength(INBOX_THREAD_LIMIT);
    const seededOpen = await h.db.conversation.count({ where: { closedAt: null, workspaceId: WS_A } });
    expect(all.counts.all).toBe(seededOpen);

    const needs = await listInboxThreads(ctx, { filter: 'needs_you' });
    expect(needs.rows.map((r) => r.leadId)).toContain(oldNeeds.id);
    expect(needs.counts.needsYou).toBeGreaterThanOrEqual(1);
    const handed = await listInboxThreads(ctx, { filter: 'handed_over' });
    expect(handed.rows.map((r) => r.leadId)).toContain(oldHanded.id);
    expect(handed.counts.handedOver).toBeGreaterThanOrEqual(1);
  });
});
