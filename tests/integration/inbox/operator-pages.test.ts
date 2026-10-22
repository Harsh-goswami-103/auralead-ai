/**
 * ADR-121 operator inbox pages rendered in-process with the employee persona's session (the T28
 * pages' method): `/dashboard/employee/<ws>/inbox` lists the workspace's threads linking into the
 * operator inbox, with the filters, the Automatic sending switch and the DEMO simulator;
 * `/dashboard/employee/<ws>/inbox/<id>` shows the conversation with its header, the customer's phone
 * (Simulated) and the composer, and, once the lead is handed over, the handoff banner and a
 * read-only composer. A workspace outside the assignments and an unknown conversation are 404.
 */
import { createElement, type FC, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import EmployeeInboxPage from '@/app/dashboard/employee/[ws]/inbox/page';
import EmployeeConversationPage from '@/app/dashboard/employee/[ws]/inbox/[conversationId]/page';
import UserConversationPage from '@/app/dashboard/user/inbox/[conversationId]/page';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { seedId } from '../../../prisma/seed/ids';
import { leadWithConversation } from '../messaging/conversation-support';
import { createInboundHarness, WS_A, type InboundHarness } from '../messaging/inbound-support';

const pageHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => pageHeaders.current }));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/dashboard/employee/smile-avenue-dental/inbox',
}));

const WS = 'smile-avenue-dental';
let h: InboundHarness;

async function signIn(userKey: string) {
  const user = await h.db.user.findUniqueOrThrow({ where: { id: seedId('user', userKey) } });
  const { token } = await createSession(h.db, { userId: user.id, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'x', userAgent: 'vitest', now: h.clock.now() });
  pageHeaders.current = new Headers({ cookie: `${sessionCookieName(h.config)}=${token}` });
}

beforeAll(async () => {
  h = await createInboundHarness('operator-pages');
}, 120_000);
afterAll(async () => h?.destroy());

const markup = (el: unknown) => renderToStaticMarkup(createElement(CsrfProvider as unknown as FC<{ token: string }>, { token: 'csrf' }, el as ReactElement));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
const noSearch = { searchParams: Promise.resolve({}) };

describe('operator inbox list', () => {
  it("lists the workspace's threads into the operator inbox, with filters, Automatic sending and the DEMO simulator", async () => {
    const { conversation } = await leadWithConversation(h, 'Do you build websites?');
    await signIn('employee');
    const html = markup(await EmployeeInboxPage({ params: Promise.resolve({ ws: WS }), ...noSearch }));
    const t = text(html);
    expect(html).toContain(`/dashboard/employee/${WS}/inbox/${conversation.id}`);
    expect(html).toContain(`/dashboard/employee/${WS}/inbox?filter=needs_you`);
    expect(html).toContain(`/dashboard/employee/${WS}/inbox?filter=handed_over`);
    expect(t).toContain('Automatic sending: Off');
    expect(t).toContain('AI replies and automated pipeline sends');
    expect(t).toContain('Simulate a customer message');
    // The workspace section nav carries the Inbox section.
    expect(html).toContain(`/dashboard/employee/${WS}/inbox"`);
  });

  it('a workspace outside the assignments is 404', async () => {
    await signIn('employee');
    await expect(EmployeeInboxPage({ params: Promise.resolve({ ws: 'ironpulse-fitness' }), ...noSearch })).rejects.toMatchObject({ digest: expect.stringContaining('404') });
  });
});

describe('operator conversation', () => {
  it("shows the header, the customer's phone (Simulated) and the composer naming the workspace", async () => {
    const { lead, conversation } = await leadWithConversation(h, 'How long does a website take?');
    await signIn('employee');
    const html = markup(await EmployeeConversationPage({ params: Promise.resolve({ ws: WS, conversationId: conversation.id }) }));
    const t = text(html);
    expect(t).toContain(lead.displayName);
    expect(t).toContain("Customer's phone");
    expect(t).toContain('Free-form until');
    expect(t).toContain('Final check happens at send.');
    expect(html).toContain(`/dashboard/employee/${WS}/leads/${lead.id}`);
    expect(html).not.toContain('/dashboard/user/quotations');
    expect(html).toContain('data-chat-wallpaper');
  });

  it('a handed-over lead shows the handoff and a read-only composer to the operator, not to the client', async () => {
    const { lead, conversation } = await leadWithConversation(h, 'Please share a quote');
    await h.db.lead.update({ where: { id: lead.id }, data: { handedOverAt: h.clock.now() } });
    await h.db.leadHandoff.create({ data: { workspaceId: WS_A, leadId: lead.id, fromUserId: seedId('user', 'employee'), summaryStatus: 'NOT_CONFIGURED', createdAt: h.clock.now() } });
    await signIn('employee');
    const operatorHtml = markup(await EmployeeConversationPage({ params: Promise.resolve({ ws: WS, conversationId: conversation.id }) }));
    expect(text(operatorHtml)).toContain('Handed over to Smile Avenue Dental Clinic by Imran Qureshi');
    expect(operatorHtml).toContain('data-composer-readonly');
    await signIn('owner');
    const clientHtml = markup(await UserConversationPage({ params: Promise.resolve({ conversationId: conversation.id }) }));
    expect(text(clientHtml)).toContain('Handed over to Smile Avenue Dental Clinic by Imran Qureshi');
    expect(clientHtml).not.toContain('data-composer-readonly');
  });

  it('an unknown conversation is 404', async () => {
    await signIn('employee');
    await expect(EmployeeConversationPage({ params: Promise.resolve({ ws: WS, conversationId: 'convmatrixprobe0000000000' }) })).rejects.toMatchObject({ digest: expect.stringContaining('404') });
  });
});
