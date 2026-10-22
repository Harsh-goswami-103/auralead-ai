/**
 * T26, R31: the Leads pages render real data in-process for each panel (next/headers returns the
 * persona's session cookie; markup checked as text). The client panel lists the workspace's leads
 * with a capped count and keyset paging, finds a Devanagari name, shows the board, opens the detail
 * sheet from `?lead=` (score breakdown, consent, source) and shows the scoring configuration
 * read-only (P9). The operator console shows the same area plus its own editor on the scoring tab,
 * and a lead page with the stage control, consent and source records. A lead id of another
 * workspace never opens a sheet.
 */
import { createElement, type FC, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import UserLeadsPage from '@/app/dashboard/user/leads/page';
import UserLeadPage from '@/app/dashboard/user/leads/[leadId]/page';
import UserScoringPage from '@/app/dashboard/user/leads/scoring/page';
import EmployeeLeadsPage from '@/app/dashboard/employee/[ws]/leads/page';
import EmployeeLeadPage from '@/app/dashboard/employee/[ws]/leads/[leadId]/page';
import EmployeeScoringPage from '@/app/dashboard/employee/[ws]/leads/scoring/page';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { seedId } from '../../../prisma/seed/ids';
import { testConfig, uninstallRuntime, useRuntime, type TestRuntime } from '../auth/support';
import { createQuoteHarness, makeLeads, WS_A, WS_B, type QuoteHarness } from './support';

const pageHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => pageHeaders.current }));
vi.mock('next/navigation', async (orig) => ({ ...(await orig<typeof import('next/navigation')>()), useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));

let h: QuoteHarness;
let runtime: TestRuntime;
let devanagariId: string;
let foreignId: string;

async function signInAs(key: string) {
  const user = await h.db.user.findUniqueOrThrow({ where: { id: seedId('user', key) } });
  const { token } = await createSession(h.db, { userId: user.id, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'x', userAgent: 'vitest', now: h.clock.now() });
  pageHeaders.current = new Headers({ cookie: `${sessionCookieName(runtime.config)}=${token}` });
}

const html = (el: unknown) => renderToStaticMarkup(createElement(CsrfProvider as unknown as FC<{ token: string }>, { token: 'csrf' }, el as ReactElement)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const sp = (q: Record<string, string>) => Promise.resolve(q);

beforeAll(async () => {
  h = await createQuoteHarness('lead-pages');
  runtime = useRuntime(h.db, testConfig('demo'), h.clock);
  const made = await makeLeads(
    h.db,
    WS_A,
    Array.from({ length: 51 }, (_, i) => ({ name: i === 50 ? 'राहुल शर्मा' : `Page Lead ${String(i).padStart(2, '0')}`, stage: i % 2 === 0 ? ('NEW' as const) : ('REPLIED' as const), score: i === 50 ? 72 : null })),
  );
  devanagariId = made[50]!.id;
  const [foreign] = await makeLeads(h.db, WS_B, [{ name: 'Foreign Page Lead' }]);
  foreignId = foreign!.id;
}, 120_000);

afterAll(async () => {
  uninstallRuntime();
  await h?.testDb.destroy();
});

describe('client panel Leads', () => {
  it('lists 50 of 51 leads with the next page link, the stage menus and the export action', async () => {
    await signInAs('owner');
    const page = await UserLeadsPage({ searchParams: sp({}) });
    // No bulk selection in the client panel (bulk sends are the operator console's).
    expect(renderToStaticMarkup(createElement(CsrfProvider as unknown as FC<{ token: string }>, { token: 'csrf' }, page as ReactElement))).not.toContain('type="checkbox"');
    const text = html(page);
    expect(text).toContain('51 leads match');
    expect(text).toContain('50 on this page');
    expect(text).toContain('Next page');
    expect(text).not.toContain('Previous page');
    expect(text).toContain('राहुल शर्मा');
    expect(text).toContain('Move to stage');
    expect(text).toContain('Export all leads (CSV)');
    expect(text).toContain('Scoring');
  });

  it('finds the Devanagari name; its detail shows the score breakdown, consent and source', async () => {
    await signInAs('owner');
    const list = html(await UserLeadsPage({ searchParams: sp({ q: 'शर्मा' }) }));
    expect(list).toContain('1 lead matches');
    // The sheet itself is a client portal (not in server markup); its body is the lead page's body.
    await expect(UserLeadsPage({ searchParams: sp({ q: 'शर्मा', lead: devanagariId }) })).resolves.toBeTruthy();
    const detail = html(await UserLeadPage({ params: Promise.resolve({ leadId: devanagariId }) }));
    expect(detail).toContain('Consent is separate from the sales stage');
    expect(detail).toContain('No source record is linked');
    expect(detail).toContain('Heuristic fit score. Not purchase intent or consent.');
    expect(detail).toContain('72 / 100');
  });

  it('a lead of another workspace never opens a sheet, and its page is 404', async () => {
    await signInAs('owner');
    const text = html(await UserLeadsPage({ searchParams: sp({ lead: foreignId }) }));
    expect(text).not.toContain('Foreign Page Lead');
    await expect(UserLeadPage({ params: Promise.resolve({ leadId: foreignId }) })).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_HTTP_ERROR_FALLBACK;404/) });
    const own = html(await UserLeadPage({ params: Promise.resolve({ leadId: devanagariId }) }));
    expect(own).toContain('राहुल शर्मा');
    expect(own).toContain('All leads');
  });

  it('the board shows one column per stage with its count', async () => {
    await signInAs('owner');
    const text = html(await UserLeadsPage({ searchParams: sp({ view: 'board' }) }));
    expect(text).toContain('Pipeline board');
    expect(text).toContain('Leads in this stage: 26');
    expect(text).toContain('Leads in this stage: 25');
    expect(text).toContain('No leads in this stage.');
  });

  it('the scoring tab is read-only for the owner (P9)', async () => {
    await signInAs('owner');
    const text = html(await UserScoringPage());
    expect(text).toContain('Active configuration: version 1');
    expect(text).toContain('Change weights');
    expect(text).toContain('Workspace owners can read the scoring configuration');
    expect(text).not.toContain('Preview on 20 leads');
  });
});

describe('operator console', () => {
  it('the lead console has the full leads area; the lead page has the stage control, consent and source', async () => {
    await signInAs('employee');
    const page = await EmployeeLeadsPage({ params: Promise.resolve({ ws: 'smile-avenue-dental' }), searchParams: sp({ stage: 'REPLIED' }) });
    // Bulk selection: one checkbox per row plus the page checkbox (the operator console only).
    expect(renderToStaticMarkup(createElement(CsrfProvider as unknown as FC<{ token: string }>, { token: 'csrf' }, page as ReactElement))).toContain('aria-label="Select every lead on this page"');
    const text = html(page);
    expect(text).toContain('Lead console');
    expect(text).toContain('25 leads match the search and filters');
    expect(text).toContain('Scoring');
    const lead = html(await EmployeeLeadPage({ params: Promise.resolve({ ws: 'smile-avenue-dental', leadId: devanagariId }) }));
    expect(lead).toContain('Stage and consent');
    expect(lead).toContain('Move to stage');
    expect(lead).toContain('No source record is linked');
  });

  it('the scoring tab is the editor for an operator with scoring.manage, read-only otherwise', async () => {
    await signInAs('employee');
    const editor = html(await EmployeeScoringPage({ params: Promise.resolve({ ws: 'smile-avenue-dental' }) }));
    expect(editor).toContain('Edit the scoring configuration');
    expect(editor).toContain('Preview on 20 leads');
    expect(editor).toContain('Activate as version 2');
    const readOnly = html(await EmployeeScoringPage({ params: Promise.resolve({ ws: 'kesari-crafts' }) }));
    expect(readOnly).toContain('Your assignment does not include scoring.manage');
    expect(readOnly).not.toContain('Preview on 20 leads');
  });
});
