/**
 * ADR-126 (slice F6): the presentation pack renders in the panels it was seeded for. With the
 * persona sessions of the role switcher, the existing pages show the codecraft-web data in-process
 * (next/headers returns the persona's cookie): the client (Aarav Mehta) lands on the studio's
 * workspace, its leads, the handed-over lead and its chats; the operator sees the studio among
 * its assignments, the Places leads with "No website listed", the simulated WhatsApp integration
 * with its authored templates and the approval queue. Checks stay at "renders the seeded facts",
 * so later slices can restyle these pages.
 */
import { createElement, type FC, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import EmployeeFinderPage from '@/app/dashboard/employee/[ws]/finder/page';
import EmployeeInboxPage from '@/app/dashboard/employee/[ws]/inbox/page';
import EmployeeImportPage from '@/app/dashboard/employee/[ws]/leads/import/page';
import EmployeeTemplatesPage from '@/app/dashboard/employee/[ws]/templates/page';
import { outboundAttempts, resetOutboundAttempts } from '@/server/adapters/http/outbound';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { seedId } from '../../../prisma/seed/ids';
import { HANDOFF_FIXTURE, PRESENTATION_SLUG, STORY_LEADS, presentationPlaces } from '../../../prisma/seed/fixtures/presentation';
import { seedDemo } from '../../../prisma/seed/seed';
import { createTestDb, type TestDb } from '../../support/db';
import { armOutboundTripwire, newTripwireCounters, tripwireArmed } from '../../support/tripwire';
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
// DEMO zero outbound (plan §5): the wire is watched while the seed runs and while every page renders.
const wire = newTripwireCounters();

beforeAll(async () => {
  resetOutboundAttempts();
  armOutboundTripwire(wire);
  testDb = await createTestDb({ label: 'seed-presentation-pages' });
  db = testDb.client();
  // The runtime's pepper keys the seeded consents and chats, as `npm run db:seed` does.
  await seedDemo(db, { config: CONFIG, now: T0 });
  runtime = useRuntime(db, CONFIG, new FixedClock(NOW));
}, 120_000);
// Armed again before every test: restoreMocks (vitest config) restores spies before each test, so the one set for the seed is gone.
beforeEach(() => armOutboundTripwire(wire));
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
    expect(thread).toContain('Business website: A responsive five-page website');
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

/** The lead-gen suite wired together (integrator): the pages the story walks through link to each other. */
describe('the lead-gen suite in the pages', () => {
  const STORY_NAV = 'Lead finder Leads Inbox Templates Approvals Integrations Pipeline Sheets Meta Extension';
  const optInLeadId = leadIdOf(STORY_LEADS.optInOnly);
  const unconfirmed = () => {
    const taken = new Set<string>(Object.values(STORY_LEADS));
    return presentationPlaces().find((p) => p.imported && !taken.has(p.key))!;
  };

  it('shows the section nav in the story order on the Leads, Import, Finder, Inbox, Templates and Approvals pages', async () => {
    await signInAs('employee');
    const pages: Record<string, string> = {
      leads: text(await EmployeeLeadsPage({ ...ws, ...sp() })),
      import: text(await EmployeeImportPage({ ...ws, ...sp() })),
      finder: text(await EmployeeFinderPage({ ...ws, ...sp() })),
      inbox: text(await EmployeeInboxPage({ ...ws, ...sp() })),
      templates: text(await EmployeeTemplatesPage(ws)),
      approvals: text(await ApprovalsPage(ws)),
    };
    for (const [name, page] of Object.entries(pages)) expect(page, name).toContain(STORY_NAV);
  });

  it('links the import page from the employee leads toolbar', async () => {
    await signInAs('employee');
    const html = renderToStaticMarkup(createElement(CsrfProvider as unknown as FC<{ token: string }>, { token: 'csrf' }, (await EmployeeLeadsPage({ ...ws, ...sp() })) as ReactElement));
    expect(html).toContain('href="/dashboard/employee/codecraft-web/leads/import"');
    expect(html).toContain('Import leads');
  });

  it('shows the reach-out panel, the hand-over action and the Places details on the operator lead page', async () => {
    await signInAs('employee');
    const place = unconfirmed();
    const page = text(await EmployeeLeadPage({ params: Promise.resolve({ ws: PRESENTATION_SLUG, leadId: leadIdOf(place.key) }) }));
    expect(page).toContain('Reach out');
    expect(page).toContain('Record WhatsApp opt-in');
    expect(page).toContain('Hand over to the client');
    expect(page).toContain('Hand over to client');
    // Places content: the DEMO attribution and "Confirm details" with the date the details expire.
    expect(page).toContain('Simulated listings from the DEMO directory');
    expect(page).toContain('Confirm details');
    expect(page).toContain('came from Google Places');
  });

  it('shows a lead with a recorded opt-in as confirmed, and the handed-over lead as read-only for the operator', async () => {
    await signInAs('employee');
    const optedIn = text(await EmployeeLeadPage({ params: Promise.resolve({ ws: PRESENTATION_SLUG, leadId: optInLeadId }) }));
    expect(optedIn).toContain('Contact details confirmed on');
    expect(optedIn).toContain('A WhatsApp opt-in was recorded');
    const handedOver = text(await EmployeeLeadPage({ params: Promise.resolve({ ws: PRESENTATION_SLUG, leadId: leadIdOf(HANDOFF_FIXTURE.place) }) }));
    expect(handedOver).toContain('Handed over');
    expect(handedOver).not.toContain('Record WhatsApp opt-in');
  });

  it('shows the handoff card with the note and the summary lines on the client lead page, and the Places details of a lead', async () => {
    await signInAs('client');
    const leadId = leadIdOf(HANDOFF_FIXTURE.place);
    const lead = text(await UserLeadPage({ params: Promise.resolve({ leadId }) }));
    for (const part of ['Handed over to you', HANDOFF_FIXTURE.note, 'What they asked', HANDOFF_FIXTURE.summary.asked, HANDOFF_FIXTURE.summary.nextStep, 'Acknowledge']) expect(lead, part).toContain(part);
    // The Places details of a lead (client side): attribution and the expiry notice sit under the contact facts.
    const plain = text(await UserLeadPage({ params: Promise.resolve({ leadId: leadIdOf(unconfirmed().key) }) }));
    expect(plain).toContain('Simulated listings from the DEMO directory');
    expect(plain).toContain('Confirm details');
  });
});

describe('DEMO zero outbound', () => {
  it('seeding the pack and rendering both panels made no outbound attempt, socket or DNS lookup', () => {
    expect(tripwireArmed(), 'the wire tripwire is armed for this test').toBe(true);
    expect(outboundAttempts()).toEqual([]);
    expect(wire).toEqual({ connect: 0, tls: 0, lookup: 0, fetch: 0 });
  });
});
