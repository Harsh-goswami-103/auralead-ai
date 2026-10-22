// T32 quality rating and messaging limit (R26, plan §5.1, §7 check 6, §13, ADR-30; fixture-tested,
// not live-verified):
// - No tier enum, tier list or tier literal anywhere in the app or the schema; the columns are
//   plain strings.
// - The `wa.qualityCheck` job stores the provider's raw values and the check time exactly as
//   returned; a field the answer lacks is stored as null and shown "Unknown, last checked T".
// - Quality RED pauses the workspace's automation (automated WhatsApp sends are skipped
//   QUALITY_PAUSED) but not human sends, with the reason audited and shown; leaving RED resumes.
// - A failed check stores nothing (the previous values and their time stay) and is audited.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createElement, type FC, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import IntegrationSetupPage from '@/app/dashboard/employee/[ws]/integrations/[kind]/page';
import { IntegrationCard } from '@/components/integrations/IntegrationCard';
import { CsrfProvider } from '@/components/patterns/csrf';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { testConfig, uninstallRuntime, useRuntime } from '../auth/support';
import { getIntegrationSetup } from '@/server/services/integrations/center';
import { armIntegrationSchedules, WA_QUALITY_CHECK_JOB } from '@/server/services/integrations/schedules';
import { REPO_ROOT } from '../../support/spawn';
import { ACCESS_TOKEN, createLiveHarness, liveLead, PHONE_ID, queueWhatsApp, WABA_ID, SIMPLE_TEMPLATE, storeTemplate, storeWhatsApp, type LiveHarness } from '../integrations/live-support';
import { fixtureAnswer, type GraphRequest } from './whatsapp-support';

const qualityFields = (r: GraphRequest) => (r.query.fields ?? '').includes('quality_rating');

const pageHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => pageHeaders.current }));
vi.mock('next/navigation', async (orig) => ({ ...(await orig<typeof import('next/navigation')>()), useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }), usePathname: () => '/dashboard/employee/live-dental-co/integrations/whatsapp' }));

let h: LiveHarness;
let integrationId: string;
let templateId: string;

beforeAll(async () => {
  h = await createLiveHarness('t32-quality-limits');
  integrationId = (await storeWhatsApp(h, { status: 'CONNECTED' })).id;
  templateId = (await storeTemplate(h, { name: 'welcome_first_touch', components: SIMPLE_TEMPLATE })).id;
}, 120_000);
afterAll(async () => h?.destroy());
/** The hourly health check runs beside the quality check: answer it as a healthy connection. */
function scriptHealth() {
  const answers = Array.from({ length: 5 }, () => fixtureAnswer('response.phone-number.json'));
  h.graph.onWhere('GET', new RegExp(`^/v24\\.0/${PHONE_ID}$`), (r) => !qualityFields(r), ...answers);
  h.graph.on('GET', new RegExp(`^/v24\\.0/${WABA_ID}$`), ...Array.from({ length: 5 }, () => fixtureAnswer('response.waba.json')));
}

beforeEach(() => {
  h.graph.reset();
  scriptHealth();
});

/** Queues this hour's quality check (as a passing connection test does) and runs the worker. */
async function runQualityCheck() {
  const ctx = await h.owner();
  await armIntegrationSchedules(h.db, ctx, { id: integrationId, workspaceId: h.workspaceId, kind: 'WHATSAPP_CLOUD' }, { runNow: true });
  await h.drain();
}

const integration = () => h.db.integration.findUniqueOrThrow({ where: { id: integrationId } });

describe('no tier enum anywhere', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === 'generated' || name === 'node_modules') continue;
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|mjs|prisma)$/.test(name)) out.push(p);
    }
    return out;
  }

  it('no source file names a messaging tier, and the schema keeps quality and limit as raw strings', () => {
    const files = [...walk(path.join(REPO_ROOT, 'src')), ...walk(path.join(REPO_ROOT, 'worker')), path.join(REPO_ROOT, 'prisma', 'schema.prisma')];
    const offenders = files.filter((f) => /TIER_(?:50|250|1K|2K|10K|100K|UNLIMITED)\b|\btier_?(?:list|enum)\b|enum\s+\w*(?:Tier|Quality)\w*/i.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
    const schema = readFileSync(path.join(REPO_ROOT, 'prisma', 'schema.prisma'), 'utf8');
    expect(schema).toMatch(/qualityRaw\s+String\?/);
    expect(schema).toMatch(/messagingLimitRaw\s+String\?/);
    expect(schema).toMatch(/limitsCheckedAt\s+DateTime\?/);
  });
});

describe('wa.qualityCheck', () => {
  it('stores the raw values and the check time exactly as returned', async () => {
    h.graph.onWhere('GET', new RegExp(`^/v24\\.0/${PHONE_ID}$`), qualityFields, fixtureAnswer('response.phone-number.json'));
    await runQualityCheck();
    expect(h.graph.requests.find((r) => r.path === `/v24.0/${PHONE_ID}`)!.query.fields).toBe('id,quality_rating,whatsapp_business_manager_messaging_limit');
    expect(await integration()).toMatchObject({ qualityRaw: 'GREEN', messagingLimitRaw: 'TIER_2K', limitsCheckedAt: h.clock.now() });
    const card = (await getIntegrationSetup(await h.owner(), 'WHATSAPP_CLOUD')).card;
    expect(card.quality).toEqual({ qualityRaw: 'GREEN', messagingLimitRaw: 'TIER_2K', checkedAt: h.clock.now(), pausesAutomation: false });
  });

  it('a field the answer lacks is stored as null and shown as Unknown with the check time', async () => {
    h.clock.advance(60 * 60_000);
    h.graph.onWhere('GET', new RegExp(`^/v24\\.0/${PHONE_ID}$`), qualityFields, fixtureAnswer('response.phone-number-no-quality.json'));
    await runQualityCheck();
    const row = await integration();
    expect(row).toMatchObject({ qualityRaw: null, messagingLimitRaw: null, limitsCheckedAt: h.clock.now() });
    const card = (await getIntegrationSetup(await h.owner(), 'WHATSAPP_CLOUD')).card;
    const html = renderToStaticMarkup(createElement(IntegrationCard, { card, workspaceSlug: h.slug, timeZone: 'Asia/Kolkata', mode: 'live', canManage: true } as never));
    expect(html).toContain('Unknown · Unknown');
    expect(html).toMatch(/Last checked: .*2026/);
  });

  it('the LIVE setup page says "Unknown, last checked <time>" and renders the credential form without any secret', async () => {
    const employee = await h.db.user.create({ data: { email: 'operator@live-dental.test', name: 'Live Operator', globalRole: 'EMPLOYEE', isDemo: false } });
    await h.db.employeeAssignment.create({ data: { employeeUserId: employee.id, workspaceId: h.workspaceId, capabilities: ['leads.read', 'integrations.manage'], active: true, createdBy: h.ownerId, createdAt: h.clock.now() } });
    const runtime = useRuntime(h.db, testConfig('live'), h.clock);
    try {
      const { token } = await createSession(h.db, { userId: employee.id, globalRole: 'EMPLOYEE', mode: 'LIVE', activeWorkspaceId: null, ipHash: 'x', userAgent: 'vitest', now: h.clock.now() });
      pageHeaders.current = new Headers({ cookie: `${sessionCookieName(runtime.config)}=${token}` });
      const page = await IntegrationSetupPage({ params: Promise.resolve({ ws: h.slug, kind: 'whatsapp' }) });
      const html = renderToStaticMarkup(createElement(CsrfProvider as unknown as FC<{ token: string }>, { token: 'csrf' }, page as ReactElement));
      const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      expect(text).toMatch(/Quality rating Unknown, last checked [^|]*2026/);
      expect(text).toMatch(/Messaging limit Unknown, last checked/);
      expect(html).toContain('type="password"');
      expect(html).toContain('Saved •••• wxyz');
      expect(html).not.toContain(ACCESS_TOKEN);
      const row = await integration();
      expect(html).not.toContain((row.secrets as Record<string, string>).accessToken!);
    } finally {
      uninstallRuntime();
    }
  });

  it('RED pauses automated WhatsApp sends (QUALITY_PAUSED) but not human sends, with the reason audited and shown', async () => {
    h.clock.advance(60 * 60_000);
    h.graph.onWhere('GET', new RegExp(`^/v24\\.0/${PHONE_ID}$`), qualityFields, fixtureAnswer('response.phone-number-red.json'));
    await runQualityCheck();
    expect(await integration()).toMatchObject({ qualityRaw: 'RED', messagingLimitRaw: 'TIER_250' });
    const paused = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'integration.quality.automation_paused', targetId: integrationId } });
    expect(paused.summary).toMatchObject({ qualityRaw: 'RED', previousQualityRaw: null, reason: expect.stringMatching(/Automated WhatsApp sends are paused/) });
    const card = (await getIntegrationSetup(await h.owner(), 'WHATSAPP_CLOUD')).card;
    expect(card.quality?.pausesAutomation).toBe(true);
    const html = renderToStaticMarkup(createElement(IntegrationCard, { card, workspaceSlug: h.slug, timeZone: 'Asia/Kolkata', mode: 'live', canManage: true } as never));
    expect(html).toContain('Automated WhatsApp sends are paused while the quality rating is RED');

    h.graph.reset();
    scriptHealth();
    h.graph.on('POST', /\/messages$/, fixtureAnswer('response.send-accepted.json'));
    const owner = await h.owner();
    const lead = await liveLead(h);
    const automated = await queueWhatsApp(h, owner, { leadId: lead.id, sendIntent: 'AUTOMATED', templateId, variables: { '1': 'A', '2': 'B' } });
    const human = await queueWhatsApp(h, owner, { leadId: lead.id, sendIntent: 'MANUAL_SINGLE', templateId, variables: { '1': 'C', '2': 'D' } });
    await h.drain();
    expect(await h.db.dispatchAttempt.findFirstOrThrow({ where: { messageId: automated.messageId } })).toMatchObject({ state: 'SKIPPED', reasonCode: 'QUALITY_PAUSED' });
    expect(await h.db.dispatchAttempt.findFirstOrThrow({ where: { messageId: human.messageId } })).toMatchObject({ state: 'SENT' });
    expect(h.graph.requests.filter((r) => r.path.endsWith('/messages'))).toHaveLength(1);
  });

  it('leaving RED resumes automation (audited); a failed check keeps the values and their time', async () => {
    h.clock.advance(60 * 60_000);
    h.graph.onWhere('GET', new RegExp(`^/v24\\.0/${PHONE_ID}$`), qualityFields, fixtureAnswer('response.phone-number.json'));
    await runQualityCheck();
    expect((await integration()).qualityRaw).toBe('GREEN');
    expect(await h.db.auditEvent.count({ where: { action: 'integration.quality.automation_resumed', targetId: integrationId } })).toBe(1);
    const checkedAt = (await integration()).limitsCheckedAt;

    h.clock.advance(60 * 60_000);
    h.graph.reset();
    scriptHealth();
    h.graph.onWhere('GET', new RegExp(`^/v24\\.0/${PHONE_ID}$`), qualityFields, { status: 500, body: { error: { message: 'unavailable', code: 2 } } });
    await runQualityCheck();
    expect(await integration()).toMatchObject({ qualityRaw: 'GREEN', messagingLimitRaw: 'TIER_2K', limitsCheckedAt: checkedAt });
    const failed = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'integration.quality.check', result: 'FAILED', targetId: integrationId } });
    expect(failed.summary).toMatchObject({ httpStatus: 500 });
    // The chain stays armed for the next hour.
    expect(await h.db.job.count({ where: { type: WA_QUALITY_CHECK_JOB, status: 'QUEUED' } })).toBeGreaterThanOrEqual(1);
  });
});
