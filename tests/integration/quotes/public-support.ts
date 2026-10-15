/**
 * Shared harness for the T16 public quote tests: the seeded DEMO DB (workspace A, the dental
 * clinic with GST 18%), the process runtime installed exactly as the app runs (so the real route
 * handlers execute in-process), a temp STORAGE_DIR for PDF artifacts, real owner contexts, and
 * helpers that issue a quote (create, approve, optionally sent) and a share link through the
 * real T15 services.
 *
 * "Sent" is set with a direct row update: the manual "Mark as sent" action (P15) is T22's and the
 * dispatch settle is T19's; neither exists yet, and the public routes only read the status.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { createLogger } from '@/lib/logger';
import type { AppCtx } from '@/server/auth/context';
import { buildJobRegistry } from '@/server/jobs/registry';
import { createQuoteRenderPdfJob } from '@/server/jobs/handlers/quote-render-pdf';
import { createService } from '@/server/services/pricing/catalog';
import { createQuoteShare } from '@/server/services/quotes/share';
import { approveQuote, createQuote } from '@/server/services/quotes/versioning';
import { createWorker, type Worker } from '../../../worker/worker';
import { createTestDb, type TestDb } from '../../support/db';
import { ORIGIN, testConfig, uninstallRuntime, useRuntime as installTestRuntime, type TestRuntime } from '../auth/support';
import { createLead, NOW, SEED_NOW, WS_A, userCtx } from './support';
import { seedDemo } from '../../../prisma/seed/seed';
import * as pageRoute from '@/app/(public)/quote/[token]/route';
import * as acceptRoute from '@/app/api/quote-share/[token]/accept/route';
import * as sharePdfRoute from '@/app/api/quote-share/[token]/pdf/route';
import * as viewRoute from '@/app/api/quote-share/[token]/view/route';

export { ORIGIN, NOW, WS_A };

export type PublicHarness = {
  testDb: TestDb;
  db: PrismaClient;
  clock: FixedClock;
  runtime: TestRuntime;
  storageDir: string;
  owner: AppCtx;
  /** The AT5 service: ₹10,000.00 per unit, discount limit 10%. */
  serviceId: string;
  destroy(): Promise<void>;
};

export async function createPublicHarness(label: string): Promise<PublicHarness> {
  const testDb = await createTestDb({ label });
  const db = testDb.client();
  await seedDemo(db, { config: { mode: 'demo' }, now: SEED_NOW });
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), `auralead-${label}-storage-`));
  const clock = new FixedClock(NOW);
  const runtime = installTestRuntime(db, testConfig('demo', { TRUSTED_PROXY_HOPS: '1', STORAGE_DIR: storageDir }), clock);
  const owner = await userCtx(db, clock, 'owner');
  const active = await db.pricingVersion.findFirstOrThrow({ where: { workspaceId: WS_A, active: true } });
  const { service } = await createService(owner, {
    code: 'AT5-PLAN',
    name: 'Smile makeover plan',
    description: 'Planning, mock-up and two review visits.',
    unitLabel: 'plan',
    defaultTimelineDays: 30,
    maxDiscountBps: 1000,
    unitPricePaise: 1_000_000n,
    minQty: 1,
    maxQty: 100,
    expectedVersion: active.version,
  });
  return {
    testDb,
    db,
    clock,
    runtime,
    storageDir,
    owner,
    serviceId: service.id,
    async destroy() {
      uninstallRuntime();
      await testDb.destroy();
      fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

export type IssuedQuote = { quoteId: string; versionId: string; leadId: string; token: string; number: string };

/**
 * The AT5 quote (2 x ₹10,000, 10% discount, GST 18% = ₹21,240.00), approved, optionally marked
 * sent, with one share link.
 */
export async function issueQuote(h: PublicHarness, opts: { sent?: boolean; leadName?: string } = {}): Promise<IssuedQuote> {
  const lead = await createLead(h.db, WS_A, opts.leadName ?? 'Asha Raman');
  const { quote, version } = await createQuote(h.owner, {
    leadId: lead.id,
    items: [{ serviceId: h.serviceId, qty: 2 }],
    discount: { kind: 'PERCENT_BPS', value: 1000n },
    scopeText: 'Smile makeover planning with a digital mock-up.',
    timelineText: 'Four weeks',
  });
  await approveQuote(h.owner, quote.id, { expectedVersion: 1 });
  if (opts.sent) await markSent(h.db, quote.id);
  const { token } = await createQuoteShare(h.owner, quote.id, {});
  return { quoteId: quote.id, versionId: version.id, leadId: lead.id, token, number: quote.number };
}

export async function markSent(db: PrismaClient, quoteId: string): Promise<void> {
  await db.quote.update({ where: { id: quoteId }, data: { status: 'SENT', sentVia: 'MANUAL_LINK' } });
}

export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

export type CallOptions = { ip?: string; ua?: string; origin?: string | null; requestId?: string; body?: unknown };

function request(pathname: string, method: 'GET' | 'POST', o: CallOptions): Request {
  const headers = new Headers({ 'user-agent': o.ua ?? BROWSER_UA, 'x-forwarded-for': o.ip ?? '203.0.113.10' });
  if (o.requestId) headers.set('x-request-id', o.requestId);
  let body: string | undefined;
  if (method === 'POST') {
    const origin = o.origin === undefined ? ORIGIN : o.origin;
    if (origin !== null) headers.set('origin', origin);
    headers.set('content-type', 'application/json');
    body = JSON.stringify(o.body ?? {});
  }
  return new Request(`${ORIGIN}${pathname}`, { method, headers, body });
}

const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

export async function getQuotePage(token: string, o: CallOptions = {}): Promise<Response> {
  return pageRoute.GET(request(`/quote/${token}`, 'GET', o), params({ token }));
}

export async function postView(token: string, o: CallOptions = {}): Promise<Response> {
  return viewRoute.POST(request(`/api/quote-share/${token}/view`, 'POST', o), params({ token }));
}

export async function postAccept(token: string, o: CallOptions = {}): Promise<Response> {
  return acceptRoute.POST(request(`/api/quote-share/${token}/accept`, 'POST', o), params({ token }));
}

export async function getSharePdf(token: string, o: CallOptions = {}): Promise<Response> {
  return sharePdfRoute.GET(request(`/api/quote-share/${token}/pdf`, 'GET', o), params({ token }));
}

/** Reads the accept form fields the public page renders (C5: nonce and expected version). */
export function acceptFormFields(html: string): { formNonce: string; expectedVersionId: string } {
  const nonce = /name="formNonce" value="([^"]+)"/.exec(html)?.[1];
  const version = /name="expectedVersionId" value="([^"]+)"/.exec(html)?.[1];
  if (!nonce || !version) throw new Error('the page has no accept form');
  return { formNonce: nonce, expectedVersionId: version };
}

export function pdfWorker(h: PublicHarness): Worker {
  return createWorker(
    {
      db: h.db,
      clock: h.clock,
      registry: buildJobRegistry([createQuoteRenderPdfJob({ mode: () => 'demo', storageDir: () => h.storageDir })]),
      logger: createLogger({ level: 'silent' }),
      mode: 'demo',
      version: 'test',
      random: () => 0,
    },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
}

export async function drain(w: Worker): Promise<number> {
  let ran = 0;
  while ((await w.tick()) === 'ran') ran += 1;
  return ran;
}
