/**
 * Lead-gen F5 (ADR-124, ADR-125): the handoff and reach-out surfaces render real data in-process
 * (next/headers returns the persona's session cookie; markup checked as text).
 * - Operator lead page before the handoff: "Hand over to client" with leads.handoff, a permission
 *   gate without it; the reach-out panel with the WhatsApp state, "Record WhatsApp opt-in" and the
 *   click-to-chat configuration gate (no WhatsApp number in the base seed).
 * - After the handoff: the operator sees the handoff card and the read-only state; the client sees
 *   "Handed over to you" with the note, the summary status and Acknowledge, then the summary with
 *   its "Local template" provenance, then who acknowledged it.
 * - The client's leads list filters on ?handedOver=1 and the command center counts open handoffs.
 */
import { createElement, type FC, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import type { Capability } from '@/lib/domain/enums';
import { createLogger } from '@/lib/logger';
import EmployeeLeadPage from '@/app/dashboard/employee/[ws]/leads/[leadId]/page';
import UserHomePage from '@/app/dashboard/user/page';
import UserLeadsPage from '@/app/dashboard/user/leads/page';
import UserLeadPage from '@/app/dashboard/user/leads/[leadId]/page';
import { createHandoffSummaryJob } from '@/server/jobs/handlers/handoff-summary';
import { buildJobRegistry } from '@/server/jobs/registry';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { acknowledgeHandoff, handOverLead } from '@/server/services/leads/handoff';
import { seedId } from '../../../prisma/seed/ids';
import { createWorker } from '../../../worker/worker';
import { testConfig, uninstallRuntime, useRuntime, type TestRuntime } from '../auth/support';
import { createQuoteHarness, makeLeads, userCtx, WS_A, type QuoteHarness } from '../leads/support';

const pageHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => pageHeaders.current }));
vi.mock('next/navigation', async (orig) => ({ ...(await orig<typeof import('next/navigation')>()), useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));

let h: QuoteHarness;
let runtime: TestRuntime;
let handedId: string;
let openId: string;
let kesariId: string;

async function signInAs(key: string) {
  const user = await h.db.user.findUniqueOrThrow({ where: { id: seedId('user', key) } });
  const { token } = await createSession(h.db, { userId: user.id, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'x', userAgent: 'vitest', now: h.clock.now() });
  pageHeaders.current = new Headers({ cookie: `${sessionCookieName(runtime.config)}=${token}` });
}

const render = (el: unknown) => renderToStaticMarkup(createElement(CsrfProvider as unknown as FC<{ token: string }>, { token: 'csrf' }, el as ReactElement));
const html = (el: unknown) => render(el).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const operatorPage = (leadId: string, ws = 'smile-avenue-dental') => EmployeeLeadPage({ params: Promise.resolve({ ws, leadId }) });

async function runSummaryJobs() {
  const worker = createWorker(
    { db: h.db, clock: h.clock, registry: buildJobRegistry([createHandoffSummaryJob({ mode: () => 'demo', deps: () => ({ keyRing: null }) })]), logger: createLogger({ level: 'silent' }), mode: 'demo', version: 'test', random: () => 0 },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
  while ((await worker.tick()) === 'ran');
}

beforeAll(async () => {
  h = await createQuoteHarness('handoff-pages');
  runtime = useRuntime(h.db, testConfig('demo'), h.clock);
  const assignment = await h.db.employeeAssignment.findUniqueOrThrow({ where: { employeeUserId_workspaceId: { employeeUserId: seedId('user', 'employee'), workspaceId: WS_A } } });
  await h.db.employeeAssignment.update({ where: { id: assignment.id }, data: { capabilities: [...(assignment.capabilities as Capability[]), 'leads.handoff'] } });
  const [handed, open] = await makeLeads(h.db, WS_A, [
    { name: 'Mehta Opticals', stage: 'REPLIED', phone: '+919800011111' },
    { name: 'Rao Bakery', stage: 'CONTACTED', phone: '+919800022222' },
  ]);
  handedId = handed!.id;
  openId = open!.id;
  const kesari = await h.db.workspace.findUniqueOrThrow({ where: { slug: 'kesari-crafts' } });
  const [k] = await makeLeads(h.db, kesari.id, [{ name: 'Kesari Lead', phone: '+919800033333' }]);
  kesariId = k!.id;
}, 120_000);

afterAll(async () => {
  uninstallRuntime();
  await h?.testDb.destroy();
});

describe('operator lead page', () => {
  it('before the handoff: "Hand over to client" and the reach-out panel', async () => {
    await signInAs('employee');
    const markup = render(await operatorPage(handedId));
    const text = markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toContain('Hand over to the client');
    expect(text).toContain('Hand over to client');
    expect(text).not.toContain('Handing a lead over needs leads.handoff');
    expect(text).toContain('Reach out');
    expect(text).toContain('No WhatsApp opt-in');
    expect(text).toContain('Record WhatsApp opt-in');
    expect(text).toContain('Get click-to-chat link');
    expect(text).toContain('WhatsApp is not connected for this workspace');
    expect(text).toContain('Workspace opt-in notice and privacy contact');
  });

  it('without leads.handoff the control is a permission gate with the reason', async () => {
    await signInAs('employee');
    const text = html(await operatorPage(kesariId, 'kesari-crafts'));
    expect(text).toContain('Handing a lead over needs leads.handoff');
    // The kesari assignment has no automation.manage: no workspace notice form.
    expect(text).not.toContain('Workspace opt-in notice and privacy contact');
  });

  it('after the handoff: the handoff card and the read-only state', async () => {
    const employee = await userCtx(h.db, h.clock, 'employee', 'smile-avenue-dental');
    const lead = await h.db.lead.findUniqueOrThrow({ where: { id: handedId } });
    await handOverLead(employee, { leadId: handedId, note: 'Wants a shop website before Diwali.', expectedStageVersion: lead.stageVersion, requestKey: 'pages-handoff-0001' }, { keyRing: null });
    await signInAs('employee');
    const text = html(await operatorPage(handedId));
    expect(text).toContain('Handed over by Imran Qureshi on');
    expect(text).toContain('This lead belongs to the client now');
    expect(text).toContain('Wants a shop website before Diwali.');
    expect(text).toContain('Summary being written');
    expect(text).toContain('This lead was handed over to the client, so reaching out is theirs now.');
    expect(text).not.toContain('Record WhatsApp opt-in');
  });
});

describe('client surfaces', () => {
  it('the lead page shows the handoff with Acknowledge, then the summary and who acknowledged it', async () => {
    await signInAs('owner');
    let text = html(await UserLeadPage({ params: Promise.resolve({ leadId: handedId }) }));
    expect(text).toContain('Handed over to you');
    expect(text).toContain('Wants a shop website before Diwali.');
    expect(text).toContain('Summary being written');
    expect(text).toContain('Acknowledge');

    await runSummaryJobs();
    text = html(await UserLeadPage({ params: Promise.resolve({ leadId: handedId }) }));
    expect(text).toContain('What they asked');
    expect(text).toContain('What was promised');
    expect(text).toContain('Next step');
    expect(text).toContain('Local template');
    expect(text).not.toContain('AI prepared');

    const owner = await userCtx(h.db, h.clock, 'owner');
    const row = await h.db.leadHandoff.findFirstOrThrow({ where: { leadId: handedId } });
    await acknowledgeHandoff(owner, { handoffId: row.id });
    text = html(await UserLeadPage({ params: Promise.resolve({ leadId: handedId }) }));
    expect(text).toContain('Acknowledged by Ananya Sharma on');
    expect(text).not.toMatch(/\bAcknowledge\b(?! by| on)/);

    // A lead that was never handed over shows no handoff block.
    expect(html(await UserLeadPage({ params: Promise.resolve({ leadId: openId }) }))).not.toContain('Handed over to you');
  });

  it('the leads list filters on ?handedOver=1 and the command center counts open handoffs', async () => {
    await signInAs('owner');
    const filtered = html(await UserLeadsPage({ searchParams: Promise.resolve({ handedOver: '1' }) }));
    expect(filtered).toContain('Mehta Opticals');
    expect(filtered).not.toContain('Rao Bakery');
    expect(filtered).toContain('Handed over to the client');
    expect(filtered).toContain('Clear filters');

    // Hand over the second lead too: one open handoff (the first was acknowledged).
    const employee = await userCtx(h.db, h.clock, 'employee', 'smile-avenue-dental');
    const lead = await h.db.lead.findUniqueOrThrow({ where: { id: openId } });
    await handOverLead(employee, { leadId: openId, expectedStageVersion: lead.stageVersion, requestKey: 'pages-handoff-0002' }, { keyRing: null });
    const home = html(await UserHomePage());
    expect(home).toMatch(/Handed over to you 1 Leads your AuraLead operator handed over/);
  });
});
