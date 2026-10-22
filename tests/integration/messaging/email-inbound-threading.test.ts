/**
 * P5 (T33, ADR-102): inbound email threading is disclosed as unsupported, not built.
 *
 * Resend's receiving product exists (search snippets of resend.com, 2026-10-20), but its webhook
 * carries metadata only and the reply text and In-Reply-To header come from the Retrieve Received
 * Email API, whose response fields could not be confirmed (resend.com is not reachable from the
 * build environment). SMTP has no inbound at all. So no inbound email is processed, and this test
 * pins the disclosure instead of the threading:
 *  - both email providers declare `inbound: false` with "Inbound email is not supported for this
 *    provider" (Resend) / "no inbound" (SMTP), in the capabilities and the catalog;
 *  - the Resend and SMTP setup pages show the disclosure in DEMO, and the LIVE Resend setup shows
 *    the workspace's own webhook URL once the credential write gave it a routing key;
 *  - no inbound email module exists, and an `email.received` delivery is acknowledged without
 *    storing anything (tests/integration/contract/resend.test.ts), so a reply can never land in a
 *    conversation by a half-built path; no Reply-To token is set on sends (resend.test.ts,
 *    smtp.test.ts), so replies go to the from mailbox.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createElement, type FC, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import IntegrationSetupPage from '@/app/dashboard/employee/[ws]/integrations/[kind]/page';
import { catalogEntry, RESEND_ROUTING_KEY_RE } from '@/lib/domain/integrations';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { getIntegrationSetup } from '@/server/services/integrations/center';
import { saveIntegrationCredentials } from '@/server/services/integrations/credentials';
import { EMAIL_PROVIDER_CAPABILITIES } from '@/server/services/messaging/inbound';
import { seedId } from '../../../prisma/seed/ids';
import { testConfig, uninstallRuntime, useRuntime } from '../auth/support';
import { createIntegrationsHarness, KEY_RING, liveOwnerCtx, WS_A_SLUG, type IntegrationsHarness } from '../integrations/support';

const pageHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => pageHeaders.current }));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/dashboard/employee/smile-avenue-dental/integrations',
}));

const UNSUPPORTED = 'Inbound email is not supported for this provider';
const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

let h: IntegrationsHarness;
beforeAll(async () => {
  h = await createIntegrationsHarness('t33-inbound-disclosure');
  const runtime = useRuntime(h.db, testConfig('demo'), h.clock);
  const { token } = await createSession(h.db, { userId: seedId('user', 'employee'), globalRole: 'EMPLOYEE', mode: 'DEMO', activeWorkspaceId: null, ipHash: 'x', userAgent: 'vitest', now: h.clock.now() });
  pageHeaders.current = new Headers({ cookie: `${sessionCookieName(runtime.config)}=${token}` });
}, 120_000);
afterAll(async () => {
  uninstallRuntime();
  await h?.testDb.destroy();
});

const text = (el: unknown) =>
  renderToStaticMarkup(createElement(CsrfProvider as unknown as FC<{ token: string }>, { token: 'csrf' }, el as ReactElement))
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ');

describe('P5: inbound email is disclosed as unsupported', () => {
  it('both providers declare no inbound, in the capabilities and the catalog', () => {
    expect(EMAIL_PROVIDER_CAPABILITIES.EMAIL_RESEND.inbound).toBe(false);
    expect(EMAIL_PROVIDER_CAPABILITIES.EMAIL_RESEND.disclosure).toContain(UNSUPPORTED);
    expect(EMAIL_PROVIDER_CAPABILITIES.EMAIL_SMTP).toMatchObject({ inbound: false, bounceTracking: false });
    expect(catalogEntry('EMAIL_RESEND').disclosures.join(' ')).toContain(UNSUPPORTED);
    expect(catalogEntry('EMAIL_SMTP').disclosures.join(' ')).toMatch(/no inbound/i);
    expect(catalogEntry('EMAIL_SMTP').disclosures.join(' ')).toMatch(/Bounces are not tracked/);
  });

  it('no inbound email module exists (nothing half-built can thread a reply)', () => {
    expect(existsSync(path.join(REPO_ROOT, 'src/server/services/messaging/email-inbound.ts'))).toBe(false);
  });

  it('the Resend and SMTP setup pages show the disclosures', async () => {
    const resend = text(await IntegrationSetupPage({ params: Promise.resolve({ ws: WS_A_SLUG, kind: 'email-resend' }) }));
    expect(resend).toContain(UNSUPPORTED);
    expect(resend).toContain('Good to know');
    const smtp = text(await IntegrationSetupPage({ params: Promise.resolve({ ws: WS_A_SLUG, kind: 'email-smtp' }) }));
    expect(smtp).toContain('SMTP has no inbound replies and no bounce tracking');
    expect(smtp).toContain('TLS is required');
  });

  it('LIVE: the credential write gives Resend its own webhook URL, shown on the setup view; DEMO shows none', async () => {
    const ctx = await liveOwnerCtx(h);
    const before = await getIntegrationSetup(ctx, 'EMAIL_RESEND');
    expect(before.webhookUrlPath).toBeNull();
    await saveIntegrationCredentials(
      ctx,
      { kind: 'EMAIL_RESEND', config: { fromDomain: 'example.com', fromAddress: 'quotes@example.com' }, credentials: { apiKey: 're_liveSetupKey00000000000000wxyz', webhookSecret: `whsec_${Buffer.alloc(32, 3).toString('base64')}` } },
      { keyRing: KEY_RING },
    );
    const row = await h.db.integration.findFirstOrThrow({ where: { workspaceId: h.liveWorkspaceId, kind: 'EMAIL_RESEND' } });
    expect(row.routingKey).toMatch(RESEND_ROUTING_KEY_RE);
    const after = await getIntegrationSetup(ctx, 'EMAIL_RESEND');
    expect(after.webhookUrlPath).toBe(`/api/webhooks/email/resend/${row.routingKey}`);
    // A later write (a key rotation) keeps the URL Resend already calls.
    await saveIntegrationCredentials(ctx, { kind: 'EMAIL_RESEND', credentials: { apiKey: 're_liveSetupKey11111111111111wxyz' } }, { keyRing: KEY_RING });
    expect((await h.db.integration.findFirstOrThrow({ where: { id: row.id } })).routingKey).toBe(row.routingKey);
    const resendPage = text(await IntegrationSetupPage({ params: Promise.resolve({ ws: WS_A_SLUG, kind: 'email-resend' }) }));
    expect(resendPage).not.toContain('/api/webhooks/email/resend/');
  });
});
