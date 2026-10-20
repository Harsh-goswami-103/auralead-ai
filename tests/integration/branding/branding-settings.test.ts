/**
 * T27 branding settings through POST /api/app/branding (withRoute: session, CSRF, role USER,
 * pricing.override): brand colour (#rrggbb only, stored upper-case), GSTIN (format only, stored
 * upper-case, empty clears it), terms (line endings normalised, at most 4000 characters). Every
 * change is one transaction with a `branding.update` audit naming the fields, never their values.
 * New quote versions snapshot the saved details (the existing document-snapshot hook), issued
 * versions keep theirs. The branding page renders for the owner with live forms and read-only for
 * a member.
 */
import { createElement, type FC, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { CsrfProvider } from '@/components/patterns/csrf';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { readDocumentSnapshot } from '@/server/services/quotes/render-model';
import * as brandingRoute from '@/app/api/app/branding/route';
import BrandingPage from '@/app/dashboard/user/pricing/branding/page';
import { seedId } from '../../../prisma/seed/ids';
import { seedDemo } from '../../../prisma/seed/seed';
import { createTestDb, type TestDb } from '../../support/db';
import { makeRequest, noParams, testConfig, uninstallRuntime, useRuntime, type TestRuntime } from '../auth/support';

const pageHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => pageHeaders.current }));
vi.mock('next/navigation', async (orig) => ({ ...(await orig<typeof import('next/navigation')>()), useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));

const SEED_NOW = new Date('2026-10-15T04:30:00.000Z');
const NOW = '2026-10-20T06:00:00.000Z';
const WS_A = seedId('workspace', 'smile-avenue-dental');

let testDb: TestDb;
let db: PrismaClient;
let runtime: TestRuntime;

beforeAll(async () => {
  testDb = await createTestDb({ label: 'branding-settings' });
  db = testDb.client();
  await seedDemo(db, { config: { mode: 'demo' }, now: SEED_NOW });
  runtime = useRuntime(db, testConfig('demo'), new FixedClock(NOW));
});
afterAll(async () => {
  uninstallRuntime();
  await testDb.destroy();
});

async function auth(userKey: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: seedId('user', userKey) } });
  const { token, session } = await createSession(db, { userId: user.id, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'branding', userAgent: 'vitest', now: new Date(NOW) });
  return { cookie: `${sessionCookieName(runtime.config)}=${token}`, csrf: csrfTokenForSession(runtime.config, session.id) };
}

async function save(userKey: string, body: Record<string, unknown>) {
  const a = await auth(userKey);
  return brandingRoute.POST(makeRequest('/api/app/branding', { body, cookie: a.cookie, csrf: a.csrf }), noParams);
}

const codeOf = async (res: Response) => ((await res.json()) as { code?: string }).code;
const settingsA = () => db.workspaceSettings.findUniqueOrThrow({ where: { workspaceId: WS_A } });

describe('POST /api/app/branding', () => {
  it('saves colour, GSTIN and terms, normalised, with one audit row naming the fields', async () => {
    const res = await save('owner', { brandColor: '#ffd400', gstin: ' 06aabcs1234k1z5 ', termsText: 'Valid for 15 days.\r\nGST as shown.  \r\n' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { branding: { brandColor: string; gstin: string | null; termsText: string } };
    expect(body.branding).toMatchObject({ brandColor: '#FFD400', gstin: '06AABCS1234K1Z5', termsText: 'Valid for 15 days.\nGST as shown.' });
    const s = await settingsA();
    expect(s).toMatchObject({ brandColor: '#FFD400', gstin: '06AABCS1234K1Z5', termsText: 'Valid for 15 days.\nGST as shown.', updatedBy: seedId('user', 'owner') });
    const audit = await db.auditEvent.findFirstOrThrow({ where: { workspaceId: WS_A, action: 'branding.update' }, orderBy: { createdAt: 'desc' } });
    expect(audit.summary).toEqual({ fields: ['brandColor', 'gstin', 'termsText'] });
  });

  it('new quote versions take the saved details from the document snapshot hook', async () => {
    const lead = await db.lead.create({ data: { workspaceId: WS_A, displayName: 'Branding Lead', nameNormalized: 'branding lead', alternatePhones: [], scoreReasons: [], unknownInputs: [], firstSource: 'MANUAL' } });
    const doc = await readDocumentSnapshot(db, { workspaceId: WS_A, leadId: lead.id });
    expect(doc).toMatchObject({ brandColor: '#FFD400', gstin: '06AABCS1234K1Z5', termsText: 'Valid for 15 days.\nGST as shown.' });
  });

  it('an empty GSTIN clears it; a partial body changes only its fields', async () => {
    const res = await save('owner', { gstin: '' });
    expect(res.status).toBe(200);
    expect(await settingsA()).toMatchObject({ gstin: null, brandColor: '#FFD400' });
  });

  it.each([
    [{ brandColor: 'red' }, 'BRAND_COLOR_INVALID'],
    [{ brandColor: '#fff' }, 'BRAND_COLOR_INVALID'],
    [{ gstin: '07AAACR5055K1Z' }, 'GSTIN_INVALID'],
    [{ gstin: 'ABCDEFGHIJKLMNO' }, 'GSTIN_INVALID'],
    [{ termsText: 'x'.repeat(4001) }, 'TERMS_INVALID'],
  ])('refuses %j with 422 %s and changes nothing', async (body, code) => {
    const before = await settingsA();
    const res = await save('owner', body);
    expect(res.status).toBe(422);
    expect(await codeOf(res)).toBe(code);
    const after = await settingsA();
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });

  it('accepts exactly 4000 characters of terms', async () => {
    expect((await save('owner', { termsText: 'y'.repeat(4000) })).status).toBe(200);
  });

  it('a member is 403, an employee 404, a foreign workspaceId 404', async () => {
    expect((await save('pooja', { brandColor: '#123456' })).status).toBe(403);
    expect((await save('employee', { brandColor: '#123456' })).status).toBe(404);
    expect((await save('owner', { brandColor: '#123456', workspaceId: seedId('workspace', 'ironpulse-fitness') })).status).toBe(404);
    expect((await settingsA()).brandColor).toBe('#FFD400');
  });
});

describe('branding page', () => {
  const html = (el: unknown) => renderToStaticMarkup(createElement(CsrfProvider as unknown as FC<{ token: string }>, { token: 'csrf' }, el as ReactElement)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  it('shows the owner the forms with the contrast-checked text colour', async () => {
    const a = await auth('owner');
    pageHeaders.current = new Headers({ cookie: a.cookie });
    const text = html(await BrandingPage());
    expect(text).toContain('Branding');
    expect(text).toContain('Save brand colour');
    expect(text).toMatch(/Text on quotations #[0-9A-F]{6}/);
    expect(text).toMatch(/\d+\.\d{2}:1 on white/);
    expect(text).toContain('Upload logo');
    expect(text).toContain('PNG, JPEG or WebP, up to 1 MB');
  });

  it('shows a member the same details read-only, with the controls gated by permission', async () => {
    const a = await auth('pooja');
    pageHeaders.current = new Headers({ cookie: a.cookie });
    const text = html(await BrandingPage());
    expect(text).toContain('Only the workspace owner can change branding.');
  });
});
