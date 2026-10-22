// ADR-121 operator inbox, ADR-122 escalations in "Needs you", ADR-123 per-lead template values and
// ADR-124 handed-over leads, through the widened routes and the inbox read model.
// - The composer, draft, mode, takeover, resume and automatic-sending routes accept an EMPLOYEE with
//   `workspaceSlug` (consoleContext): the assigned operator acts in the workspace; without a slug, or
//   with a workspace outside the assignment, it is 404; a missing capability is 403.
// - Once a lead is handed over, the operator's thread is read-only (events name the client and the
//   operator; sends are 409 HANDED_OVER even when the window is closed), while the client carries on.
// - An escalation feeds Needs you until a person replies (composer clears it; an approved draft sent
//   after it settles it in the read model).
// - A template's values are resolved for the lead on the server; a missing one is 422 with its reason.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { approveAndSendMessage } from '@/server/services/messaging/dispatch';
import { getInboxThread, listInboxThreads, sendComposerMessage } from '@/server/services/messaging/inbox';
import { WINDOW_MS } from '@/server/services/messaging/window';
import { POST as messagesRoute } from '@/app/api/app/messages/route';
import { POST as draftsRoute } from '@/app/api/app/messages/drafts/route';
import { POST as modeRoute } from '@/app/api/app/conversations/[conversationId]/mode/route';
import { POST as takeoverRoute } from '@/app/api/app/conversations/[conversationId]/takeover/route';
import { POST as resumeRoute } from '@/app/api/app/conversations/[conversationId]/resume/route';
import { POST as autoSendRoute } from '@/app/api/app/settings/auto-send/route';
import { seedId } from '../../../prisma/seed/ids';
import { makeRequest } from '../auth/support';
import { DEPS as DISPATCH_DEPS, grantConsent } from '../dispatch/support';
import { userCtx } from '../quotes/support';
import { leadWithConversation } from '../messaging/conversation-support';
import { createInboundHarness, PEPPER, WS_A, type InboundHarness } from '../messaging/inbound-support';

const WS_A_SLUG = 'smile-avenue-dental';
const DEPS = { contactKeyPepper: PEPPER, externalOutboundPause: false };

let h: InboundHarness;
beforeAll(async () => {
  h = await createInboundHarness('operator-inbox');
}, 120_000);
afterAll(async () => h?.destroy());

async function auth(userKey: string) {
  const user = await h.db.user.findUniqueOrThrow({ where: { id: seedId('user', userKey) } });
  const { token, session } = await createSession(h.db, { userId: user.id, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'operator', userAgent: 'vitest', now: h.clock.now() });
  return { cookie: `${sessionCookieName(h.config)}=${token}`, csrf: csrfTokenForSession(h.config, session.id) };
}

type Route = (req: Request, seg: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(route: Route, url: string, userKey: string, body: unknown, params: Record<string, string> = {}) {
  const a = await auth(userKey);
  const res = await route(makeRequest(url, { body, cookie: a.cookie, csrf: a.csrf }), { params: Promise.resolve(params) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const operator = () => userCtx(h.db, h.clock, 'employee', WS_A_SLUG);

describe('widened routes (ADR-121)', () => {
  it('the assigned operator sends from the composer with workspaceSlug; without it, or from outside the assignment, 404', async () => {
    const { conversation } = await leadWithConversation(h, 'Do you have Saturday slots?');
    const body = { conversationId: conversation.id, kind: 'TEXT', body: 'Yes, Saturday works.' };
    const sent = await call(messagesRoute as Route, '/api/app/messages', 'employee', { ...body, requestKey: 'operator-key-0001', workspaceSlug: WS_A_SLUG });
    expect(sent.status).toBe(200);
    const attempt = await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: String(sent.body.attemptId) } });
    expect(attempt).toMatchObject({ sendIntent: 'MANUAL_SINGLE', initiatedBy: seedId('user', 'employee') });
    expect((await call(messagesRoute as Route, '/api/app/messages', 'employee', { ...body, requestKey: 'operator-key-0002' })).status).toBe(404);
    expect((await call(messagesRoute as Route, '/api/app/messages', 'neha', { ...body, requestKey: 'operator-key-0003', workspaceSlug: WS_A_SLUG })).status).toBe(404);
    expect((await call(messagesRoute as Route, '/api/app/messages', 'neha', { ...body, requestKey: 'operator-key-0004', workspaceSlug: 'ironpulse-fitness' })).status).toBe(403);

    const draft = await call(draftsRoute as Route, '/api/app/messages/drafts', 'employee', { ...body, workspaceSlug: WS_A_SLUG });
    expect(draft.status).toBe(200);
    expect(await h.db.approval.findFirstOrThrow({ where: { id: String(draft.body.approvalId) } })).toMatchObject({ status: 'PENDING' });
  });

  it('take over, resume and mode change as the operator; the owner sees the same versions', async () => {
    const { conversation } = await leadWithConversation(h, 'Hello there');
    const params = { conversationId: conversation.id };
    const taken = await call(takeoverRoute as Route, `/api/app/conversations/${conversation.id}/takeover`, 'employee', { workspaceSlug: WS_A_SLUG, expectedModeVersion: conversation.modeVersion }, params);
    expect(taken).toMatchObject({ status: 200, body: { humanTakeover: true, changed: true } });
    const resumed = await call(resumeRoute as Route, `/api/app/conversations/${conversation.id}/resume`, 'employee', { workspaceSlug: WS_A_SLUG, expectedModeVersion: taken.body.modeVersion }, params);
    expect(resumed).toMatchObject({ status: 200, body: { humanTakeover: false } });
    const off = await call(modeRoute as Route, `/api/app/conversations/${conversation.id}/mode`, 'employee', { workspaceSlug: WS_A_SLUG, aiMode: 'OFF' }, params);
    expect(off).toMatchObject({ status: 200, body: { aiMode: 'OFF', changed: true } });
    expect((await call(modeRoute as Route, `/api/app/conversations/${conversation.id}/mode`, 'neha', { workspaceSlug: 'ironpulse-fitness', aiMode: 'DRAFT' }, params)).status).toBe(403);
    expect(await h.db.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).toMatchObject({ aiMode: 'OFF', modeVersion: conversation.modeVersion + 3 });
  });

  it('automatic sending: the operator with automation.manage turns it on and off (audited once each); a read-only operator is 403', async () => {
    const on = await call(autoSendRoute as Route, '/api/app/settings/auto-send', 'employee', { workspaceSlug: WS_A_SLUG, enabled: true });
    expect(on).toMatchObject({ status: 200, body: { enabled: true, changed: true } });
    expect(await call(autoSendRoute as Route, '/api/app/settings/auto-send', 'employee', { workspaceSlug: WS_A_SLUG, enabled: true })).toMatchObject({ status: 200, body: { changed: false } });
    expect((await h.db.workspaceSettings.findUniqueOrThrow({ where: { workspaceId: WS_A } })).autoSendEnabled).toBe(true);
    const off = await call(autoSendRoute as Route, '/api/app/settings/auto-send', 'owner', { enabled: false });
    expect(off).toMatchObject({ status: 200, body: { enabled: false, changed: true } });
    const audits = await h.db.auditEvent.findMany({ where: { workspaceId: WS_A, action: 'workspace.auto_send' }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => (a.summary as { enabled: boolean }).enabled)).toEqual([true, false]);
    expect((await call(autoSendRoute as Route, '/api/app/settings/auto-send', 'neha', { workspaceSlug: 'ironpulse-fitness', enabled: true })).status).toBe(403);
  });
});

describe('handed-over leads (ADR-124)', () => {
  it("are read-only for the operator, with the handoff event naming the client and the operator; the client carries on", async () => {
    const { lead, conversation } = await leadWithConversation(h, 'I would like a website');
    const at = h.clock.now();
    await h.db.lead.update({ where: { id: lead.id }, data: { handedOverAt: at } });
    await h.db.leadHandoff.create({ data: { workspaceId: WS_A, leadId: lead.id, fromUserId: seedId('user', 'employee'), note: 'Wants a five-page site', summaryStatus: 'NOT_CONFIGURED', createdAt: at } });

    const asOperator = await getInboxThread(await operator(), conversation.id, DEPS);
    expect(asOperator.readOnly?.reason).toContain('Handed over to Smile Avenue Dental Clinic');
    expect(asOperator.permissions).toMatchObject({ canSend: false, canDraft: false, canChangeMode: false });
    expect(asOperator.handoff).toMatchObject({ clientName: 'Smile Avenue Dental Clinic', operatorName: 'Imran Qureshi', status: 'HANDED_OVER', note: 'Wants a five-page site' });
    expect(asOperator.events.find((e) => e.kind === 'HANDOFF')?.label).toBe('Handed over to Smile Avenue Dental Clinic by Imran Qureshi.');

    const asClient = await getInboxThread(await h.owner(), conversation.id, DEPS);
    expect(asClient.readOnly).toBeNull();
    expect(asClient.permissions.canSend).toBe(true);
    const handedOver = await listInboxThreads(await h.owner(), { filter: 'handed_over' });
    expect(handedOver.rows.map((r) => r.conversationId)).toContain(conversation.id);
    expect(handedOver.rows.find((r) => r.conversationId === conversation.id)?.handedOverAt?.toISOString()).toBe(at.toISOString());
    expect(handedOver.counts.handedOver).toBeGreaterThanOrEqual(1);

    // Even with the window closed, the operator is refused for the handoff (409), not the window (422).
    h.clock.set(new Date(conversation.lastInboundProviderAt!.getTime() + WINDOW_MS + 1));
    const refused = await call(messagesRoute as Route, '/api/app/messages', 'employee', { workspaceSlug: WS_A_SLUG, conversationId: conversation.id, requestKey: 'handed-over-0001', kind: 'TEXT', body: 'Hello?' });
    expect(refused).toMatchObject({ status: 409, body: { code: 'HANDED_OVER' } });
    const mode = await call(modeRoute as Route, `/api/app/conversations/${conversation.id}/mode`, 'employee', { workspaceSlug: WS_A_SLUG, aiMode: 'OFF' }, { conversationId: conversation.id });
    expect(mode).toMatchObject({ status: 409, body: { code: 'HANDED_OVER' } });
  });
});

describe('escalations feed Needs you until a person replies (ADR-122)', () => {
  it('the composer clears escalatedAt; an approved draft sent after it settles it in the read model', async () => {
    const { conversation } = await leadWithConversation(h, 'Hello');
    h.clock.set(new Date(conversation.lastInboundProviderAt!.getTime() + 60_000));
    const owner = await h.owner();
    await h.db.conversation.update({ where: { id: conversation.id }, data: { escalatedAt: h.clock.now() } });
    const row = async () => (await listInboxThreads(owner, {})).rows.find((r) => r.conversationId === conversation.id)!;
    expect(await row()).toMatchObject({ escalated: true, needsYou: true });
    expect((await listInboxThreads(owner, { filter: 'needs_you' })).rows.map((r) => r.conversationId)).toContain(conversation.id);
    expect((await getInboxThread(owner, conversation.id, DEPS)).conversation.escalated).toBe(true);

    h.clock.advance(1_000);
    await sendComposerMessage(owner, { conversationId: conversation.id, requestKey: 'escalation-0001', kind: 'TEXT', body: 'A colleague will call you today.' }, DEPS);
    expect((await h.db.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).escalatedAt).toBeNull();
    expect((await row()).escalated).toBe(false);

    // Approving the pending draft (the queue's path) after a new escalation settles it as well.
    h.clock.advance(1_000);
    await h.db.conversation.update({ where: { id: conversation.id }, data: { escalatedAt: h.clock.now() } });
    expect((await row()).escalated).toBe(true);
    const draft = await h.db.message.findFirstOrThrow({ where: { conversationId: conversation.id, status: 'DRAFT' } });
    h.clock.advance(1_000);
    await approveAndSendMessage(owner, { messageId: draft.id }, DISPATCH_DEPS);
    expect((await row()).escalated).toBe(false);
  });
});

describe('per-lead template values (ADR-123)', () => {
  it('are resolved on the server: the composer shows them, a missing one is 422 with its reason, then the send carries the values', async () => {
    const { lead, conversation } = await leadWithConversation(h, 'Send me details');
    await grantConsent(h.db, lead, 'WHATSAPP');
    await h.db.lead.update({ where: { id: lead.id }, data: { displayName: 'Priya Sharma', city: null } });
    const template = await h.db.whatsAppTemplate.create({
      data: {
        workspaceId: WS_A,
        integrationId: h.integrationId,
        name: 'site_intro',
        language: 'en',
        category: 'MARKETING',
        status: 'APPROVED',
        components: [
          { type: 'HEADER', format: 'TEXT', text: 'Smile Avenue' },
          { type: 'BODY', text: 'Hi {{1}}, we serve {{2}}. {{3}}' },
          { type: 'FOOTER', text: 'Reply STOP to opt out' },
          { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Stop promotions' }] },
        ],
        variableSchema: [{ name: '1', component: 'BODY', source: 'lead.firstName' }, { name: '2', component: 'BODY', source: 'lead.city' }, { name: '3', component: 'BODY', source: 'manual' }],
        variableMap: { body: { '1': 'lead.firstName', '2': 'lead.city', '3': 'manual' }, buttons: {} },
        categoryHistory: [],
        syncedAt: h.clock.now(),
      },
    });
    const owner = await h.owner();
    const composer = (await getInboxThread(owner, conversation.id, DEPS)).composer;
    const entry = composer.templates.find((t) => t.id === template.id)!;
    expect(entry.fields.map((f) => [f.position, f.source, f.value, f.editable, f.missing])).toEqual([
      ['1', 'lead.firstName', 'Priya', false, null],
      ['2', 'lead.city', null, false, 'NO_VALUE'],
      ['3', 'manual', null, true, null],
    ]);
    expect(entry.preview).toMatchObject({ headerText: 'Smile Avenue', body: 'Hi Priya, we serve {{2}}. {{3}}', footer: 'Reply STOP to opt out', buttons: [{ type: 'QUICK_REPLY', text: 'Stop promotions' }] });

    const input = { conversationId: conversation.id, kind: 'TEMPLATE' as const, templateId: template.id, variables: { '1': 'Somebody else', '3': 'Ask us anything.' } };
    await expect(sendComposerMessage(owner, { ...input, requestKey: 'template-key-0001' }, DEPS)).rejects.toMatchObject({
      status: 422,
      code: 'TEMPLATE_VARIABLES_MISSING',
      safeDetails: { missing: [{ position: '2', source: 'lead.city', reason: 'NO_VALUE' }] },
    });
    await h.db.lead.update({ where: { id: lead.id }, data: { city: 'Indore' } });
    const sent = await sendComposerMessage(owner, { ...input, requestKey: 'template-key-0002' }, DEPS);
    // Lead sources come from the lead, never from the request; manual positions from the request.
    expect((await h.db.message.findUniqueOrThrow({ where: { id: sent.messageId } })).variables).toEqual({ '1': 'Priya', '2': 'Indore', '3': 'Ask us anything.' });
    const thread = await getInboxThread(owner, conversation.id, DEPS);
    expect(thread.messages.find((m) => m.id === sent.messageId)?.template).toMatchObject({ headerText: 'Smile Avenue', body: 'Hi Priya, we serve Indore. Ask us anything.' });
  });
});
