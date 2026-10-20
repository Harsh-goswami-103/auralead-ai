/**
 * T28 employee pages rendered in-process with the employee persona's session (the quote pages'
 * method): the assignment overview with per-workspace counts and section links; the Integration
 * center (every card, "Set up" on Not configured, the DEMO note, internal caps labelled internal,
 * no secret material in the HTML even when credentials are stored); the setup page with masked
 * credentials and the webhook URL; the pipeline editor (the read-only list for narrow screens and
 * the keyboard panel, versions, per-stage execution counts); and the Sheets, Meta and Extension
 * pages with their simulators and empty states. A workspace outside the assignments is a 404.
 */
import { createElement, type FC, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import EmployeeHomePage from '@/app/dashboard/employee/page';
import IntegrationsPage from '@/app/dashboard/employee/[ws]/integrations/page';
import IntegrationSetupPage from '@/app/dashboard/employee/[ws]/integrations/[kind]/page';
import PipelinePage from '@/app/dashboard/employee/[ws]/pipeline/page';
import SheetsPage from '@/app/dashboard/employee/[ws]/sheets/page';
import MetaPage from '@/app/dashboard/employee/[ws]/meta/page';
import ExtensionPage from '@/app/dashboard/employee/[ws]/extension/page';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { seedId } from '../../../prisma/seed/ids';
import { testConfig, uninstallRuntime, useRuntime, type TestRuntime } from '../auth/support';
import { createIntegrationsHarness, integrationWithSecrets, WS_A, WS_A_SLUG, type IntegrationsHarness } from './support';

const pageHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => pageHeaders.current }));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/dashboard/employee/smile-avenue-dental/integrations',
}));

let h: IntegrationsHarness;
let runtime: TestRuntime;
const TOKEN = 'EAAG-page-secret-PLAINTEXT-zz99';
let envelope = '';

beforeAll(async () => {
  h = await createIntegrationsHarness('integration-pages');
  runtime = useRuntime(h.db, testConfig('demo'), h.clock);
  const { token } = await createSession(h.db, { userId: seedId('user', 'employee'), globalRole: 'EMPLOYEE', mode: 'DEMO', activeWorkspaceId: null, ipHash: 'x', userAgent: 'vitest', now: h.clock.now() });
  pageHeaders.current = new Headers({ cookie: `${sessionCookieName(runtime.config)}=${token}` });
  // Stored credentials in DEMO (as T32 would write them): the pages may show only "saved + last four".
  const row = await integrationWithSecrets(h.db, { workspaceId: WS_A, kind: 'AI_ANTHROPIC', status: 'SIMULATED', config: { modelId: 'claude-opus-5-5' }, secrets: { apiKey: TOKEN } });
  envelope = (row.secrets as Record<string, string>).apiKey!;
}, 120_000);

afterAll(async () => {
  uninstallRuntime();
  await h?.testDb.destroy();
});

const markup = (el: unknown) => renderToStaticMarkup(createElement(CsrfProvider as unknown as FC<{ token: string }>, { token: 'csrf' }, el as ReactElement));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const ws = () => ({ params: Promise.resolve({ ws: WS_A_SLUG }) });
const wsKind = (kind: string) => ({ params: Promise.resolve({ ws: WS_A_SLUG, kind }) });

function expectNoSecrets(html: string) {
  expect(html).not.toContain(TOKEN);
  expect(html).not.toContain('PLAINTEXT');
  expect(html).not.toContain(envelope);
  expect(html).not.toMatch(/v1\.k1\.[A-Za-z0-9_-]+\./);
}

describe('assignment overview', () => {
  it('shows per-workspace counts, integration health and every section link', async () => {
    const html = markup(await EmployeeHomePage());
    const t = text(html);
    expect(t).toContain('Approvals waiting');
    expect(t).toContain('Integrations needing attention');
    expect(t).toContain('Smile Avenue Dental Clinic');
    expect(t).toMatch(/1 simulated · 6 not configured/);
    expect(t).toContain('v1, human approval');
    for (const segment of ['integrations', 'pipeline', 'sheets', 'meta', 'extension']) expect(html).toContain(`/dashboard/employee/${WS_A_SLUG}/${segment}`);
  });
});

describe('Integration center', () => {
  it('lists every integration with Set up on Not configured, the DEMO note and the internal cap label', async () => {
    const html = markup(await IntegrationsPage(ws()));
    const t = text(html);
    for (const label of ['WhatsApp Cloud API', 'Resend email', 'SMTP email', 'Meta Lead Ads', 'Google Sheets', 'Anthropic', 'OpenAI']) expect(t).toContain(label);
    expect(t).toContain('Set up');
    expect(html).toContain(`/dashboard/employee/${WS_A_SLUG}/integrations/email-smtp`);
    expect(t).toContain('Not configured');
    expect(t).toContain('Internal cap, not a provider limit');
    expect(t).toContain('No provider is contacted');
    expect(t).toContain('Test connection');
    expectNoSecrets(html);
  });

  it('the setup page shows masked credentials and never the secret', async () => {
    const html = markup(await IntegrationSetupPage(wsKind('ai-anthropic')));
    const t = text(html);
    expect(t).toContain('Anthropic setup');
    expect(t).toContain('•••• zz99');
    expect(t).toContain('claude-opus-5-5');
    expect(t).toContain('Before you connect');
    expectNoSecrets(html);
  });

  it('the WhatsApp setup page shows the webhook URL and the template sync', async () => {
    const t = text(markup(await IntegrationSetupPage(wsKind('whatsapp'))));
    expect(t).toContain('http://localhost:3000/api/webhooks/whatsapp');
    expect(t).toContain('Sync templates');
    expect(t).toContain('No templates synced');
  });

  it('an unknown integration slug or a workspace outside the assignments is 404', async () => {
    await expect(IntegrationSetupPage(wsKind('telegram'))).rejects.toMatchObject({ digest: expect.stringContaining('404') });
    await expect(IntegrationsPage({ params: Promise.resolve({ ws: 'ironpulse-fitness' }) })).rejects.toMatchObject({ digest: expect.stringContaining('404') });
  });
});

describe('pipeline page', () => {
  it('renders the read-only list, the keyboard panel, versions and per-stage counts', async () => {
    const html = markup(await PipelinePage(ws()));
    const t = text(html);
    expect(html).toContain('data-pipeline-list');
    expect(t).toContain('the pipeline can be edited on a screen at least 768 px wide');
    expect(html).toContain('data-pipeline-editor');
    expect(t).toContain('Add connection');
    expect(t).toContain('Execution status per stage');
    expect(html).toContain('data-version="1"');
    expect(t).toContain('Active');
  });
});

describe('source pages', () => {
  it('Sheets: Not configured, no mapping yet, the simulator', async () => {
    const t = text(markup(await SheetsPage(ws())));
    expect(t).toContain('Google Sheets');
    expect(t).toContain('Not configured');
    expect(t).toContain('No column mapping yet');
    expect(t).toContain('Simulate');
    expect(t).toContain('A Sheet URL alone grants no access');
  });

  it('Meta: no campaigns for the ad account, the simulator', async () => {
    const t = text(markup(await MetaPage(ws())));
    expect(t).toContain('No campaigns found for this ad account');
    expect(t).toContain('Simulate Instant Form leads');
  });

  it('Extension: no tokens, the batch format and the simulator', async () => {
    const html = markup(await ExtensionPage(ws()));
    const t = text(html);
    expect(t).toContain('No ingestion tokens');
    expect(html).toContain('data-example-payload');
    expect(t).toContain('Simulate a batch');
  });
});
