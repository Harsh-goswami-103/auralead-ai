// T22 User Inbox read model and composer (R24, R31, AT9 at the composer, 06-design F5, F6, F7).
// - The thread list shows each open conversation with its last message, AI mode, takeover and the
//   window state computed by the server (`windowEndsAt`), never by the browser.
// - The thread view carries the messages with their delivery state, the approval of each draft,
//   events (takeover, resume, AI replies cancelled by takeover) and the composer's eligibility from
//   the shared dispatch eligibility function.
// - The composer send is MANUAL_SINGLE, approved by the sender (payload hash bound, O3), and
//   idempotent per request key (a double click or a retry queues one dispatch). At the window
//   boundary (exclusive, safety margin 0) a free-form send is refused with WINDOW_CLOSED and the
//   next action (template or review); nothing is queued. "Save for review" keeps the text as a DRAFT
//   with a PENDING approval.
// - Routes: the composer and mode routes answer for the caller's own workspace only (404 across).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { withTx } from '@/server/db/tx';
import { setWorkspaceAutoSend, takeOverConversation } from '@/server/services/messaging/conversations';
import { queueOutboundMessage } from '@/server/services/messaging/dispatch';
import { getInboxThread, listInboxThreads, saveComposerDraft, sendComposerMessage } from '@/server/services/messaging/inbox';
import { WINDOW_MS } from '@/server/services/messaging/window';
import { POST as messagesRoute } from '@/app/api/app/messages/route';
import { POST as takeoverRoute } from '@/app/api/app/conversations/[conversationId]/takeover/route';
import { POST as resumeRoute } from '@/app/api/app/conversations/[conversationId]/resume/route';
import { seedId } from '../../../prisma/seed/ids';
import { makeRequest } from '../auth/support';
import { createLead } from '../dispatch/support';
import { leadWithConversation } from '../messaging/conversation-support';
import { createInboundHarness, PEPPER, WS_A, type InboundHarness } from '../messaging/inbound-support';

let h: InboundHarness;
const DEPS = { contactKeyPepper: PEPPER, externalOutboundPause: false };

beforeAll(async () => {
  h = await createInboundHarness('inbox-ui');
}, 120_000);

afterAll(async () => {
  await h?.destroy();
});

async function auth(userKey: string) {
  const user = await h.db.user.findUniqueOrThrow({ where: { id: seedId('user', userKey) } });
  const { token, session } = await createSession(h.db, { userId: user.id, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'inbox', userAgent: 'vitest', now: h.clock.now() });
  return { cookie: `${sessionCookieName(h.config)}=${token}`, csrf: csrfTokenForSession(h.config, session.id) };
}

type Route = (req: Request, seg: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(route: Route, url: string, userKey: string, body: unknown, params: Record<string, string> = {}) {
  const a = await auth(userKey);
  const res = await route(makeRequest(url, { body, cookie: a.cookie, csrf: a.csrf }), { params: Promise.resolve(params) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('inbox read model', () => {
  it('lists the thread with its last message, mode and server-computed window', async () => {
    const { lead, conversation } = await leadWithConversation(h, 'Hello, do you do whitening?');
    const owner = await h.owner();
    const threads = await listInboxThreads(owner, {});
    const row = threads.rows.find((t) => t.conversationId === conversation.id);
    expect(row).toBeDefined();
    expect(row).toMatchObject({ leadId: lead.id, leadName: lead.displayName, channel: 'WHATSAPP', aiMode: 'DRAFT', humanTakeover: false, windowOpen: true });
    expect(row!.windowEndsAt!.getTime()).toBe(conversation.lastInboundProviderAt!.getTime() + WINDOW_MS);
    // The reply guard left a draft suggestion waiting for a person (DRAFT thread).
    expect(row!.pendingApprovals).toBe(1);
    expect(row!.needsYou).toBe(true);
    expect(threads.counts.needsYou).toBeGreaterThanOrEqual(1);
    const needsYou = await listInboxThreads(owner, { filter: 'needs_you' });
    expect(needsYou.rows.map((t) => t.conversationId)).toContain(conversation.id);
  });

  it('thread view: messages with delivery state, the draft approval, composer eligibility and no template', async () => {
    const { conversation } = await leadWithConversation(h, 'What are your timings?');
    const owner = await h.owner();
    const thread = await getInboxThread(owner, conversation.id, DEPS);
    const inbound = thread.messages.find((m) => m.direction === 'IN');
    expect(inbound).toMatchObject({ body: 'What are your timings?', simulated: false });
    const draft = thread.messages.find((m) => m.direction === 'OUT');
    // ADR-122: a service question's suggestion comes from the conversation_reply task (DEMO: the labelled local generator).
    expect(draft).toMatchObject({ status: 'DRAFT', generatorLabel: 'local-deterministic', approval: { status: 'PENDING' } });
    expect(draft!.approval!.flags).toContain('ai_reply');
    expect(thread.composer.channel).toBe('WHATSAPP');
    expect(thread.composer.freeform).toMatchObject({ eligible: true, reasons: [] });
    expect(thread.composer.freeform.windowEndsAt!.getTime()).toBe(conversation.lastInboundProviderAt!.getTime() + WINDOW_MS);
    expect(thread.composer.templates).toEqual([]);
    expect(thread.composer.templateGate).toMatchObject({ category: 'configuration' });
    expect(thread.permissions).toMatchObject({ canSend: true, canDraft: true, canChangeMode: true });
    expect(thread.serverNow.toISOString()).toBe(h.clock.now().toISOString());
  });

  it('another workspace cannot read the thread (404)', async () => {
    const { conversation } = await leadWithConversation(h, 'Hi');
    const rohan = await (await import('../quotes/support')).userCtx(h.db, h.clock, 'rohan');
    await expect(getInboxThread(rohan, conversation.id, DEPS)).rejects.toMatchObject({ status: 404 });
  });
});

describe('composer (AT9 at send, O3, idempotency)', () => {
  it('free-form send just inside the window is queued once per request key and sent', async () => {
    const { conversation } = await leadWithConversation(h, 'Can I book for Saturday?');
    const owner = await h.owner();
    const opened = conversation.lastInboundProviderAt!.getTime();
    h.clock.set(new Date(opened + WINDOW_MS - 1));
    const input = { conversationId: conversation.id, requestKey: 'composer-key-0001', kind: 'TEXT' as const, body: 'Yes, Saturday 11 am works.' };
    const [a, b, c] = await Promise.all([sendComposerMessage(owner, input, DEPS), sendComposerMessage(owner, input, DEPS), sendComposerMessage(owner, input, DEPS)]);
    expect(new Set([a.messageId, b.messageId, c.messageId]).size).toBe(1);
    expect([a, b, c].filter((r) => r.created)).toHaveLength(1);
    const attempts = await h.db.dispatchAttempt.findMany({ where: { messageId: a.messageId } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ sendIntent: 'MANUAL_SINGLE', initiatedBy: owner.actor!.userId });
    const approval = await h.db.approval.findFirstOrThrow({ where: { messageId: a.messageId } });
    expect(approval).toMatchObject({ kind: 'OUTBOUND_MESSAGE', status: 'APPROVED', decidedBy: owner.actor!.userId });
    expect(approval.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(attempts[0]!.approvalId).toBe(approval.id);
    const callsBefore = h.wa.calls.length;
    await h.drain();
    expect(h.wa.calls.length).toBe(callsBefore + 1);
    const thread = await getInboxThread(owner, conversation.id, DEPS);
    expect(thread.messages.find((m) => m.id === a.messageId)).toMatchObject({ status: 'SENT', statusLabel: 'Sent' });
  });

  it('1 ms past the boundary the free-form send is refused WINDOW_CLOSED with the next action, nothing queued', async () => {
    const { conversation } = await leadWithConversation(h, 'Are you open tomorrow?');
    const owner = await h.owner();
    const opened = conversation.lastInboundProviderAt!.getTime();
    h.clock.set(new Date(opened + WINDOW_MS + 1));
    const before = await h.db.message.count({ where: { conversationId: conversation.id, direction: 'OUT', status: { not: 'DRAFT' } } });
    await expect(
      sendComposerMessage(owner, { conversationId: conversation.id, requestKey: 'composer-key-0002', kind: 'TEXT', body: 'We open at 10.' }, DEPS),
    ).rejects.toMatchObject({ status: 422, code: 'SEND_REFUSED', safeDetails: { reasons: ['WINDOW_CLOSED'], next: 'REVIEW' } });
    expect(await h.db.message.count({ where: { conversationId: conversation.id, direction: 'OUT', status: { not: 'DRAFT' } } })).toBe(before);
    const thread = await getInboxThread(owner, conversation.id, DEPS);
    expect(thread.composer.freeform).toMatchObject({ eligible: false, reasons: ['WINDOW_CLOSED'], windowEndsAt: null });

    // "Save for review": the text is kept as a draft waiting for approval.
    const saved = await saveComposerDraft(owner, { conversationId: conversation.id, kind: 'TEXT', body: 'We open at 10.' }, DEPS);
    const message = await h.db.message.findFirstOrThrow({ where: { id: saved.messageId } });
    expect(message).toMatchObject({ status: 'DRAFT', body: 'We open at 10.' });
    expect(await h.db.approval.findFirstOrThrow({ where: { id: saved.approvalId } })).toMatchObject({ status: 'PENDING', kind: 'OUTBOUND_MESSAGE' });
  });

  it('an automated reply queued before a takeover is skipped at dispatch and shows as cancelled by takeover', async () => {
    const owner = await h.owner();
    await setWorkspaceAutoSend(owner, { enabled: true });
    const { lead, conversation } = await leadWithConversation(h, 'Hello again');
    const queued = await withTx(owner.db, async (tx) => {
      const q = await queueOutboundMessage(tx, owner, { kind: 'TEXT', body: 'Thanks for your message.', leadId: lead.id, channel: 'WHATSAPP', sendIntent: 'AUTOMATED', initiatedBy: 'system:reply.auto', dedupeKey: `inbox-test:${conversation.id}`, generatorLabel: 'reply-guard' }, DEPS);
      const c = await tx.conversation.findFirstOrThrow({ where: { id: conversation.id } });
      await tx.message.update({ where: { id: q.messageId }, data: { modeVersionAtCreate: c.modeVersion } });
      return q;
    });
    await takeOverConversation(owner, { conversationId: conversation.id });
    await h.drain();
    const thread = await getInboxThread(owner, conversation.id, DEPS);
    expect(thread.conversation.humanTakeover).toBe(true);
    expect(thread.messages.find((m) => m.id === queued.messageId)).toMatchObject({ status: 'NOT_SENT', note: 'AI reply cancelled by takeover' });
    expect(thread.events.map((e) => e.label)).toContain('You took over this conversation. AI replies paused.');
    await setWorkspaceAutoSend(owner, { enabled: false });
  });
});

describe('routes', () => {
  it('POST /api/app/messages queues the composer send; another workspace answers 404', async () => {
    const { conversation } = await leadWithConversation(h, 'Price for cleaning?');
    h.clock.set(new Date(conversation.lastInboundProviderAt!.getTime() + 60_000));
    const ok = await call(messagesRoute as Route, '/api/app/messages', 'owner', { conversationId: conversation.id, requestKey: 'route-key-0001', kind: 'TEXT', body: 'Cleaning is listed on our price list.' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ created: true });
    const again = await call(messagesRoute as Route, '/api/app/messages', 'owner', { conversationId: conversation.id, requestKey: 'route-key-0001', kind: 'TEXT', body: 'Cleaning is listed on our price list.' });
    expect(again.body).toMatchObject({ messageId: ok.body.messageId, created: false });
    const foreign = await call(messagesRoute as Route, '/api/app/messages', 'rohan', { conversationId: conversation.id, requestKey: 'route-key-0002', kind: 'TEXT', body: 'x' });
    expect(foreign.status).toBe(404);
  });

  it('takeover and resume routes bump the mode version; a stale version is 409', async () => {
    const { conversation } = await leadWithConversation(h, 'I want to talk to someone');
    const url = `/api/app/conversations/${conversation.id}/takeover`;
    const taken = await call(takeoverRoute as Route, url, 'owner', { expectedModeVersion: conversation.modeVersion }, { conversationId: conversation.id });
    expect(taken.status).toBe(200);
    expect(taken.body).toMatchObject({ humanTakeover: true, changed: true });
    const stale = await call(resumeRoute as Route, `/api/app/conversations/${conversation.id}/resume`, 'owner', { expectedModeVersion: conversation.modeVersion }, { conversationId: conversation.id });
    expect(stale.status).toBe(409);
    const resumed = await call(resumeRoute as Route, `/api/app/conversations/${conversation.id}/resume`, 'owner', { expectedModeVersion: taken.body.modeVersion }, { conversationId: conversation.id });
    expect(resumed.body).toMatchObject({ humanTakeover: false, changed: true });
    const foreign = await call(takeoverRoute as Route, url, 'rohan', {}, { conversationId: conversation.id });
    expect(foreign.status).toBe(404);
  });

  it('a lead without a conversation never appears; leads of workspace A only', async () => {
    const lonely = await createLead(h.db);
    const owner = await h.owner();
    const threads = await listInboxThreads(owner, {});
    expect(threads.rows.some((t) => t.leadId === lonely.id)).toBe(false);
    expect(threads.rows.every((t) => t.conversationId.length > 0)).toBe(true);
    expect(await h.db.conversation.count({ where: { workspaceId: WS_A } })).toBe(threads.rows.length);
  });
});
