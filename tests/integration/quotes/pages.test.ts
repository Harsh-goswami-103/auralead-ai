/**
 * T15 Quotations pages render real data for the workspace owner: the list shows the seeded quote
 * with its persisted total, the detail page shows the version lines, totals, actions and timeline,
 * and "new from proposal" pre-fills the editor from the lead's AI draft. Pages run in-process with
 * `next/headers` returning the owner's session cookie; the rendered markup is checked as text.
 */
import { createElement, type FC, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { CsrfProvider } from '@/components/patterns/csrf';
import ListPage from '@/app/dashboard/user/quotations/page';
import DetailPage from '@/app/dashboard/user/quotations/[quoteId]/page';
import NewPage from '@/app/dashboard/user/quotations/new/page';
import { seedId } from '../../../prisma/seed/ids';
import { testConfig, uninstallRuntime, useRuntime, type TestRuntime } from '../auth/support';
import { createDraft, createQuoteHarness, SERVICE_B, WS_B, type QuoteHarness } from './support';

const pageHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => pageHeaders.current }));
vi.mock('next/navigation', async (orig) => ({ ...(await orig<typeof import('next/navigation')>()), useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));

let h: QuoteHarness;
let runtime: TestRuntime;
const QUOTE_B = seedId('quote', 'ironpulse-fitness:Q-0001');
const LEAD_B = seedId('lead', 'ironpulse-fitness:Q-0001');

beforeAll(async () => {
  h = await createQuoteHarness('quote-pages');
  runtime = useRuntime(h.db, testConfig('demo'), h.clock);
  const { token } = await createSession(h.db, { userId: seedId('user', 'rohan'), globalRole: 'USER', mode: 'DEMO', activeWorkspaceId: null, ipHash: 'x', userAgent: 'vitest', now: h.clock.now() });
  pageHeaders.current = new Headers({ cookie: `${sessionCookieName(runtime.config)}=${token}` });
});
afterAll(async () => {
  uninstallRuntime();
  await h?.testDb.destroy();
});

const html = (el: unknown) => renderToStaticMarkup(createElement(CsrfProvider as unknown as FC<{ token: string }>, { token: 'csrf' }, el as ReactElement)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('Quotations pages', () => {
  it('the list shows the seeded quote with its persisted total and status', async () => {
    const text = html(await ListPage());
    expect(text).toContain('Q-0001');
    expect(text).toContain('Kunal Deshpande');
    expect(text).toContain('₹16,992.00');
    expect(text).toContain('Draft');
    expect(text).toContain('New quotation');
  });

  it('the detail page shows lines, totals, actions and the timeline', async () => {
    const text = html(await DetailPage({ params: Promise.resolve({ quoteId: QUOTE_B }) }));
    expect(text).toContain('Personal training pack');
    expect(text).toContain('₹14,400.00');
    expect(text).toContain('GST (18%)');
    expect(text).toContain('₹16,992.00');
    expect(text).toContain('Approve v1');
    expect(text).toContain('Created as a draft');
    expect(text).toContain('waiting for approval');
  });

  it('new from proposal pre-fills the editor from the lead draft', async () => {
    await createDraft(h.db, LEAD_B, { items: [{ serviceId: SERVICE_B, qty: 2 }], workspaceId: WS_B });
    const text = html(await NewPage({ searchParams: Promise.resolve({ leadId: LEAD_B }) }));
    expect(text).toContain('Quotation for Kunal Deshpande');
    expect(text).toContain('Started from the proposal');
    expect(text).toContain('Personal training pack');
    expect(text).toContain('Create draft quotation');
  });
});
