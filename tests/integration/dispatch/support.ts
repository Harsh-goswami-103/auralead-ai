/**
 * Harness for the T19 dispatch tests: the seeded DEMO DB, real user contexts (owner persona of
 * workspace A), a temp STORAGE_DIR (quote PDFs, demo outbox, outbound.lock) and journal dir, and an
 * in-process worker running the production handlers: quote.renderPdf, dispatch.whatsapp,
 * dispatch.email and suppression.journalReconcile.
 *
 * The dispatch transports are scripted test doubles that record every call and answer with the
 * outcome the test queues (default: sent). They stand in for the provider; the production DEMO
 * transport is exercised separately (outbound-tripwire, lease-expiry-send, worker-restart).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Channel, PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { createLogger } from '@/lib/logger';
import type { EmailSendRequest, EmailTransport } from '@/server/adapters/email/port';
import type { SendOutcome, WaSendRequest, WhatsAppTransport } from '@/server/adapters/whatsapp/port';
import type { AppCtx } from '@/server/auth/context';
import { createDispatchEmailJob } from '@/server/jobs/handlers/dispatch-email';
import { deriveUnsubscribeKey } from '@/server/services/messaging/dispatch';
import { createDispatchWhatsAppJob } from '@/server/jobs/handlers/dispatch-whatsapp';
import type { DispatchRuntimeDeps } from '@/server/jobs/handlers/dispatch-run';
import { createQuoteRenderPdfJob } from '@/server/jobs/handlers/quote-render-pdf';
import { createSuppressionJournalReconcileJob } from '@/server/jobs/handlers/suppression-journal-reconcile';
import { buildJobRegistry } from '@/server/jobs/registry';
import type { JobDefinition } from '@/server/jobs/types';
import { contactKey } from '@/server/security/contact-key';
import { createQuote } from '@/server/services/quotes/versioning';
import { seedId } from '../../../prisma/seed/ids';
import { seedDemo } from '../../../prisma/seed/seed';
import { createWorker, type Worker } from '../../../worker/worker';
import { createTestDb, removeDir, type TestDb } from '../../support/db';
import { userCtx } from '../quotes/support';

export const SEED_NOW = new Date('2026-10-15T04:30:00.000Z');
export const NOW = '2026-10-16T06:00:00.000Z';
export const PEPPER = `dispatch-test-pepper-${'p'.repeat(32)}`;
export const WS_A = seedId('workspace', 'smile-avenue-dental');
export const SERVICE_CONSULT = seedId('service', 'smile-avenue-dental:CONSULT');
export const OWNER_ID = seedId('user', 'owner');

type Call<R> = { request: R; at: string };

/** A provider stand-in: records each call and answers with the next queued outcome (default sent). */
export class ScriptedTransport<R extends { attemptId: string }> {
  readonly calls: Array<Call<R>> = [];
  readonly label = 'demo' as const;
  readonly simulated = true;
  #queue: Array<SendOutcome | ((r: R) => Promise<SendOutcome>)> = [];
  constructor(private readonly clock: FixedClock) {}
  answer(...outcomes: Array<SendOutcome | ((r: R) => Promise<SendOutcome>)>): this {
    this.#queue.push(...outcomes);
    return this;
  }
  /** Drops outcomes queued but not consumed. */
  reset(): void {
    this.#queue = [];
  }
  async send(request: R): Promise<SendOutcome> {
    this.calls.push({ request, at: this.clock.now().toISOString() });
    const next = this.#queue.shift();
    if (typeof next === 'function') return next(request);
    return next ?? { status: 'sent', providerMessageId: `prov.${request.attemptId}`, simulated: true };
  }
}

export const rateLimited = (retryAfterMs = 30_000): SendOutcome => ({
  status: 'failed',
  failureClass: 'RETRYABLE',
  reasonCode: 'RATE_LIMITED',
  error: 'HTTP 429',
  retryAfterMs,
  suppress: false,
  manualRetryAfterMs: null,
  throttleScope: 'workspace',
});
export const permanent = (reasonCode = 'PROVIDER_REJECTED'): SendOutcome => ({
  status: 'failed',
  failureClass: 'PERMANENT',
  reasonCode,
  error: 'HTTP 400',
  suppress: false,
  manualRetryAfterMs: null,
  throttleScope: null,
});
export const ambiguous = (): SendOutcome => ({ status: 'ambiguous', reasonCode: 'TIMEOUT_AFTER_WRITE', error: 'socket timeout after write' });

export type DispatchHarness = {
  testDb: TestDb;
  db: PrismaClient;
  clock: FixedClock;
  storageDir: string;
  journalDir: string;
  lockFile: string;
  flags: { envOutboundPaused: boolean; mode: 'demo' | 'live' };
  wa: ScriptedTransport<WaSendRequest> & WhatsAppTransport;
  email: ScriptedTransport<EmailSendRequest> & EmailTransport;
  runtimeDeps: () => DispatchRuntimeDeps;
  worker: Worker;
  defs: JobDefinition[];
  drain: () => Promise<number>;
  owner: () => Promise<AppCtx>;
  destroy: () => Promise<void>;
};

export async function createDispatchHarness(label: string, extraDefs: (h: Pick<DispatchHarness, 'db' | 'clock'>) => JobDefinition[] = () => []): Promise<DispatchHarness> {
  const testDb = await createTestDb({ label });
  const db = testDb.client();
  await seedDemo(db, { config: { mode: 'demo' }, now: SEED_NOW });
  const clock = new FixedClock(NOW);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `auralead-${label}-`));
  const storageDir = path.join(base, 'storage');
  const journalDir = path.join(base, 'journal');
  fs.mkdirSync(storageDir, { recursive: true });
  const lockFile = path.join(base, 'outbound.lock');
  const flags = { envOutboundPaused: false, mode: 'demo' as 'demo' | 'live' };
  const wa = new ScriptedTransport<WaSendRequest>(clock) as ScriptedTransport<WaSendRequest> & WhatsAppTransport;
  const email = new ScriptedTransport<EmailSendRequest>(clock) as ScriptedTransport<EmailSendRequest> & EmailTransport;
  const runtimeDeps = (): DispatchRuntimeDeps => ({
    contactKeyPepper: PEPPER,
    storageDir,
    appOrigin: 'http://localhost:3000',
    unsubscribeKey: deriveUnsubscribeKey('dispatch-test-session-secret'),
    outboundLockFile: lockFile,
    envOutboundPaused: flags.envOutboundPaused,
  });
  const dispatchOptions = { mode: () => flags.mode, deps: runtimeDeps, whatsapp: () => wa, email: () => email };
  const defs: JobDefinition[] = [
    createQuoteRenderPdfJob({ mode: () => 'demo', storageDir: () => storageDir }),
    createDispatchWhatsAppJob(dispatchOptions),
    createDispatchEmailJob(dispatchOptions),
    createSuppressionJournalReconcileJob({ deps: () => ({ journalDir }) }),
    ...extraDefs({ db, clock }),
  ];
  const worker = createWorker(
    { db, clock, registry: buildJobRegistry(defs), logger: createLogger({ level: 'silent' }), mode: 'demo', version: 'test', random: () => 0 },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
  const drain = async () => {
    let ran = 0;
    while ((await worker.tick()) === 'ran') ran += 1;
    return ran;
  };
  return {
    testDb,
    db,
    clock,
    storageDir,
    journalDir,
    lockFile,
    flags,
    wa,
    email,
    runtimeDeps,
    worker,
    defs,
    drain,
    owner: () => userCtx(db, clock, 'owner'),
    destroy: async () => {
      await testDb.destroy();
      await removeDir(base);
    },
  };
}

export const DEPS = { contactKeyPepper: PEPPER };

let leadSeq = 0;
export async function createLead(db: PrismaClient, opts: { phone?: string | null; email?: string | null; source?: 'MANUAL' | 'GMAPS_EXTENSION'; workspaceId?: string } = {}) {
  leadSeq += 1;
  const name = `Dispatch Lead ${leadSeq}`;
  return db.lead.create({
    data: {
      workspaceId: opts.workspaceId ?? WS_A,
      displayName: name,
      nameNormalized: name.toLowerCase(),
      phoneE164: opts.phone === undefined ? `+9198220${String(leadSeq).padStart(5, '0')}` : opts.phone,
      emailNormalized: opts.email === undefined ? `lead${leadSeq}@example.test` : opts.email,
      alternatePhones: [],
      scoreReasons: [],
      unknownInputs: [],
      firstSource: opts.source ?? 'MANUAL',
    },
  });
}

/** An un-withdrawn consent row, keyed by the contact HMAC exactly like the consent service writes it. */
export async function grantConsent(
  db: PrismaClient,
  lead: { id: string; workspaceId: string; phoneE164: string | null; emailNormalized: string | null },
  channel: Channel,
  basis: 'OPT_IN' | 'B2B_ATTESTED' | 'INBOUND_MESSAGE' = 'OPT_IN',
  collectedAt = new Date('2026-10-01T00:00:00.000Z'),
) {
  const value = channel === 'WHATSAPP' ? lead.phoneE164! : lead.emailNormalized!;
  return db.consentRecord.create({
    data: {
      workspaceId: lead.workspaceId,
      leadId: lead.id,
      contactKey: contactKey(PEPPER, channel === 'WHATSAPP' ? 'phone' : 'email', value),
      channel,
      purpose: basis === 'INBOUND_MESSAGE' ? 'SERVICE_CONVERSATION' : 'MARKETING',
      basis,
      source: basis === 'OPT_IN' ? 'MANUAL_EVIDENCE' : basis === 'B2B_ATTESTED' ? 'EMPLOYEE_ATTESTATION' : 'INBOUND_MESSAGE',
      evidence: { note: 'test evidence' },
      collectedAt,
      recordedAt: collectedAt,
    },
  });
}

/** A WhatsApp integration (SIMULATED) with one APPROVED template, as T32's sync stores it. */
export async function approvedTemplate(db: PrismaClient, workspaceId = WS_A, name = 'quote_ready') {
  const integration =
    (await db.integration.findFirst({ where: { workspaceId, kind: 'WHATSAPP_CLOUD' } })) ??
    (await db.integration.create({ data: { workspaceId, kind: 'WHATSAPP_CLOUD', status: 'SIMULATED', config: {} } }));
  return (
    (await db.whatsAppTemplate.findFirst({ where: { integrationId: integration.id, name } })) ??
    db.whatsAppTemplate.create({
      data: {
        workspaceId,
        integrationId: integration.id,
        name,
        language: 'en',
        category: 'UTILITY',
        status: 'APPROVED',
        components: [],
        variableSchema: [],
        variableMap: {},
        categoryHistory: [],
        syncedAt: new Date(NOW),
        intent: 'QUOTE_READY',
      },
    })
  );
}

/** A DRAFT quote v1 for the lead with its PDF rendered by the real render job. */
export async function quoteWithPdf(h: DispatchHarness, leadId: string, ctx?: AppCtx) {
  const owner = ctx ?? (await h.owner());
  const created = await createQuote(owner, {
    leadId,
    items: [{ serviceId: SERVICE_CONSULT, qty: 1 }],
    discount: { kind: 'NONE', value: 0n },
    scopeText: 'Consultation and plan.',
    timelineText: 'One visit',
  });
  await h.drain();
  const artifact = await h.db.quoteArtifact.findFirst({ where: { quoteVersionId: created.version.id } });
  if (!artifact) throw new Error('quote PDF was not rendered');
  return created;
}

/** A lead that may receive WhatsApp templates and email (opt-in on both channels). */
export async function eligibleLead(db: PrismaClient) {
  const lead = await createLead(db);
  await grantConsent(db, lead, 'WHATSAPP');
  await grantConsent(db, lead, 'EMAIL');
  return lead;
}

export async function attemptsOf(db: PrismaClient, messageId: string) {
  return db.dispatchAttempt.findMany({ where: { messageId }, orderBy: { attemptNo: 'asc' } });
}

export async function auditActions(db: PrismaClient, since?: Date) {
  const rows = await db.auditEvent.findMany({ where: { workspaceId: WS_A, ...(since ? { createdAt: { gte: since } } : {}) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { action: true, targetId: true, summary: true } });
  return rows;
}
