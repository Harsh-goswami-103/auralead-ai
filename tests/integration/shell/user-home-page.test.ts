/**
 * The owner's command center (truthful UI, design spec §0.1; T25): a workspace with no leads says
 * so in plain words instead of drawing an empty funnel, every KPI shows its stored zero (never a
 * placeholder or an invented number), "Needs you" says nothing is waiting, and confirmed revenue
 * reads unavailable. A workspace with a draft quotation counts it. The page runs in-process with
 * `next/headers` returning the owner's session cookie; the markup is read as text.
 */
import { createElement, type FC, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { CsrfProvider } from '@/components/patterns/csrf';
import UserHomePage from '@/app/dashboard/user/page';
import { seedId } from '../../../prisma/seed/ids';
import { testConfig, uninstallRuntime, useRuntime, type TestRuntime } from '../auth/support';
import { createQuoteHarness, type QuoteHarness } from '../quotes/support';

const pageHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => pageHeaders.current }));
vi.mock('next/navigation', async (orig) => ({ ...(await orig<typeof import('next/navigation')>()), useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));

let h: QuoteHarness;
let runtime: TestRuntime;

beforeAll(async () => {
  h = await createQuoteHarness('user-home-page');
  runtime = useRuntime(h.db, testConfig('demo'), h.clock);
});
afterAll(async () => {
  uninstallRuntime();
  await h?.testDb.destroy();
});

async function signIn(userKey: string) {
  const { token } = await createSession(h.db, { userId: seedId('user', userKey), globalRole: 'USER', mode: 'DEMO', activeWorkspaceId: null, ipHash: 'x', userAgent: 'vitest', now: h.clock.now() });
  pageHeaders.current = new Headers({ cookie: `${sessionCookieName(runtime.config)}=${token}` });
}

const html = (el: unknown) => renderToStaticMarkup(createElement(CsrfProvider as unknown as FC<{ token: string }>, { token: 'csrf' }, el as ReactElement)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('User command center', () => {
  it('says "No leads yet" and shows stored zeros for a workspace without leads', async () => {
    await signIn('owner');
    const text = html(await UserHomePage());
    expect(text).toContain('Smile Avenue Dental Clinic');
    expect(text).toContain('New leads (7 days) 0');
    expect(text).toContain('Pipeline value ₹0.00');
    expect(text).toContain('No leads yet');
    expect(text).toContain('Nothing needs you right now.');
    expect(text).toMatch(/Confirmed revenue Unavailable No payment data/);
    expect(text).not.toContain('Services priced');
  });

  it("counts workspace B's seeded draft quotation as awaiting approval", async () => {
    await signIn('rohan');
    const text = html(await UserHomePage());
    expect(text).toContain('Quotes awaiting approval 1');
    expect(text).not.toContain('No leads yet');
  });
});
