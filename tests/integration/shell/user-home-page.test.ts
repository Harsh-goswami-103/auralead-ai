/**
 * The owner's command center (truthful UI, design spec §0.1): the "Services priced" tile says every
 * service has a price only when there is at least one service. Once every service is archived the
 * catalog is empty and the tile says so, instead of "0 / 0 Every service has a price". The page runs
 * in-process with `next/headers` returning the owner's session cookie; the markup is read as text.
 */
import { createElement, type FC, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { CsrfProvider } from '@/components/patterns/csrf';
import UserHomePage from '@/app/dashboard/user/page';
import { seedId } from '../../../prisma/seed/ids';
import { testConfig, uninstallRuntime, useRuntime, type TestRuntime } from '../auth/support';
import { createQuoteHarness, WS_B, type QuoteHarness } from '../quotes/support';

const pageHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => pageHeaders.current }));
vi.mock('next/navigation', async (orig) => ({ ...(await orig<typeof import('next/navigation')>()), useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));

let h: QuoteHarness;
let runtime: TestRuntime;

beforeAll(async () => {
  h = await createQuoteHarness('user-home-page');
  runtime = useRuntime(h.db, testConfig('demo'), h.clock);
  const { token } = await createSession(h.db, { userId: seedId('user', 'rohan'), globalRole: 'USER', mode: 'DEMO', activeWorkspaceId: null, ipHash: 'x', userAgent: 'vitest', now: h.clock.now() });
  pageHeaders.current = new Headers({ cookie: `${sessionCookieName(runtime.config)}=${token}` });
});
afterAll(async () => {
  uninstallRuntime();
  await h?.testDb.destroy();
});

const html = (el: unknown) => renderToStaticMarkup(createElement(CsrfProvider as unknown as FC<{ token: string }>, { token: 'csrf' }, el as ReactElement)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('User home "Services priced" tile', () => {
  it('claims every service has a price only when there are services', async () => {
    const seeded = html(await UserHomePage());
    expect(seeded).toContain('Services priced');
    expect(seeded).toMatch(/Every service has a price|needs? a price/);
    expect(seeded).not.toContain('No services yet');

    await h.db.service.updateMany({ where: { workspaceId: WS_B, archivedAt: null }, data: { archivedAt: h.clock.now() } });
    const empty = html(await UserHomePage());
    expect(empty).toContain('Services priced 0 / 0 No services yet');
    expect(empty).not.toContain('Every service has a price');
  });
});
