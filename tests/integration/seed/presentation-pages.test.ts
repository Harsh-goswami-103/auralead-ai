/**
 * ADR-126 (slice F6): the presentation pack renders in the panels it was seeded for. With the
 * persona sessions of the role switcher, the existing pages show the codecraft-web data in-process
 * (next/headers returns the persona's cookie): the client (Aarav Mehta) lands on the studio's
 * workspace, its leads, the handed-over lead and its chats; the operator sees the studio among
 * its assignments, the Places leads with "No website listed", the simulated WhatsApp integration
 * with its authored templates and the approval queue. Checks stay at "renders the seeded facts",
 * so later slices can restyle these pages.
 */
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { createElement, type FC, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { CsrfProvider } from '@/components/patterns/csrf';
import UserHomePage from '@/app/dashboard/user/page';
import UserLeadsPage from '@/app/dashboard/user/leads/page';
import UserLeadPage from '@/app/dashboard/user/leads/[leadId]/page';
import InboxPage from '@/app/dashboard/user/inbox/page';
import ConversationPage from '@/app/dashboard/user/inbox/[conversationId]/page';
import EmployeeHomePage from '@/app/dashboard/employee/page';
import EmployeeLeadsPage from '@/app/dashboard/employee/[ws]/leads/page';
import EmployeeLeadPage from '@/app/dashboard/employee/[ws]/leads/[leadId]/page';
import IntegrationsPage from '@/app/dashboard/employee/[ws]/integrations/page';
import IntegrationSetupPage from '@/app/dashboard/employee/[ws]/integrations/[kind]/page';
import ApprovalsPage from '@/app/dashboard/employee/[ws]/approvals/page';
import { outboundAttempts, resetOutboundAttempts } from '@/server/adapters/http/outbound';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { seedId } from '../../../prisma/seed/ids';
import { HANDOFF_FIXTURE, PRESENTATION_SLUG, STORY_LEADS, presentationPlaces } from '../../../prisma/seed/fixtures/presentation';
import { seedDemo } from '../../../prisma/seed/seed';
import { createTestDb, type TestDb } from '../../support/db';
import { testConfig, uninstallRuntime, useRuntime, type TestRuntime } from '../auth/support';

const pageHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => pageHeaders.current }));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/dashboard/user',
  useSearchParams: () => new URLSearchParams(),
}));

const T0 = new Date('2026-10-15T04:00:00.000Z');
const NOW = new Date(T0.getTime() + 10 * 60_000);
const CONFIG = testConfig('demo');
const WS = seedId('workspace', PRESENTATION_SLUG);
const leadIdOf = (place: string) => seedId('lead', `${PRESENTATION_SLUG}:${place}`);
const nameOf = (place: string) => presentationPlaces().find((p) => p.key === place)!.name;

let testDb: TestDb;
let db: PrismaClient;
let runtime: TestRuntime;
// DEMO zero outbound (plan §5): the wire is watched from before the seed until the last page renders.
let wire: { connect: { mock: { calls: unknown[] } }; tls: { mock: { calls: unknown[] } }; lookup: { mock: { calls: unknown[] } } };

beforeAll(async () => {
  resetOutboundAttempts();
  wire = { connect: vi.spyOn(net.Socket.prototype, 'connect'), tls: vi.spyOn(tls, 'connect'), lookup: vi.spyOn(dns, 'lookup') };
  testDb = await createTestDb({ label: 'seed-presentation-pages' });
  db = testDb.client();
  // The runtime's pepper keys the seeded consents and chats, as `npm run db:seed` does.
  await seedDemo(db, { config: CONFIG, now: T0 });
  runtime = useRuntime(db, CONFIG, new FixedClock(NOW));
}, 120_000);
afterAll(async () => {
  uninstallRuntime();
  await testDb?.destroy();
});

async function signInAs(key: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: seedId('user', key) } });
  const { token } = await createSession(db, { userId: user.id, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'x', userAgent: 'vitest', now: NOW });
  pageHeaders.current = new Headers({ cookie: `${sessionCookieName(runtime.config)}=${token}` });
}

const text = (el: unknown) =>
  renderToStaticMarkup(createElement(CsrfProvider as unknown as FC<{ token: string }>, { token: 'csrf' }, el as ReactElement))
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
const sp = (q: Record<string, string> = {}) => ({ searchParams: Promise.resolve(q) });
const ws = { params: Promise.resolve({ ws: PRESENTATION_SLUG }) };

describe('the client panel (Codecraft client persona)', () => {
  it('opens the studio workspace with its leads', async () => {
    await signInAs('client');
    expect(text(await UserHomePage())).toContain('Codecraft Web Studio');
    const leads = text(await UserLeadsPage(sp()));
    expect(leads).toContain('12 leads');
    for (const place of Object.values(STORY_LEADS)) expect(leads).toContain(nameOf(place));
  });

  it('shows the handed-over lead and the chats in the inbox', async () => {
    await signInAs('client');
    const lead = text(await UserLeadPage({ params: Promise.resolve({ leadId: leadIdOf(HANDOFF_FIXTURE.place) }) }));
    expect(lead).toContain(nameOf(HANDOFF_FIXTURE.place));
    expect(lead).toContain('Converted');
    const inbox = text(await InboxPage(sp()));
    for (const place of [STORY_LEADS.autoChat, STORY_LEADS.escalated, STORY_LEADS.handedOver]) expect(inbox).toContain(nameOf(place));
    const thread = text(await ConversationPage({ params: Promise.resolve({ conversationId: seedId('conversation', `${PRESENTATION_SLUG}:auto-chat`) }) }));
    expect(thread).toContain('what do you include in a business website?');
    expect(thread).toContain('Business website is a responsive five-page website');
  });
});

describe('the operator panel (Employee persona)', () => {
  it('lists the studio among the assignments', async () => {
    await signInAs('employee');
    expect(text(await EmployeeHomePage())).toContain('Codecraft Web Studio');
  });

  it('shows the Places leads with no website listed and a lead page with its score', async () => {
    await signInAs('employee');
    const consoleText = text(await EmployeeLeadsPage({ ...ws, ...sp() }));
    expect(consoleText).toContain(nameOf(STORY_LEADS.optInOnly));
    expect(consoleText).toContain('Google Places');
    const lead = text(await EmployeeLeadPage({ params: Promise.resolve({ ws: PRESENTATION_SLUG, leadId: leadIdOf(STORY_LEADS.optInOnly) }) }));
    expect(lead).toContain(nameOf(STORY_LEADS.optInOnly));
    expect(lead).toContain('No website listed');
  });

  it('shows the simulated WhatsApp integration with the authored templates, and the approval queue', async () => {
    await signInAs('employee');
    expect(text(await IntegrationsPage(ws))).toContain('WhatsApp Cloud API');
    const setup = text(await IntegrationSetupPage({ params: Promise.resolve({ ws: PRESENTATION_SLUG, kind: 'whatsapp' }) }));
    for (const name of ['website_intro', 'follow_up', 'meeting_confirm', 'brochure_share', 'discount_blast']) expect(setup).toContain(name);
    expect(await db.workspace.count({ where: { id: WS } })).toBe(1);
    expect(text(await ApprovalsPage(ws))).toBeTruthy();
  });
});

describe('DEMO zero outbound', () => {
  it('seeding the pack and rendering both panels made no outbound attempt, socket or DNS lookup', () => {
    expect(outboundAttempts()).toEqual([]);
    expect(wire.connect.mock.calls).toHaveLength(0);
    expect(wire.tls.mock.calls).toHaveLength(0);
    expect(wire.lookup.mock.calls).toHaveLength(0);
  });
});
