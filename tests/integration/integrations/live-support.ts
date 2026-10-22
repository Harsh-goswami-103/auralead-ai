/**
 * LIVE harness for T32: a migrated DB with no DEMO seed (a LIVE process never sees DEMO data), one
 * LIVE workspace with its settings and a non-demo owner (OWNER holds every capability) and a
 * MEMBER (no integrations.manage), real user contexts from DB sessions in a LIVE process, a temp
 * STORAGE_DIR (demo outbox would land there: it must stay empty in LIVE), and an in-process worker
 * running the production handlers (dispatch, integration health, quality check, template sync)
 * with the scripted Graph stand-in as their only transport. Zero outbound connections.
 */
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { createLogger } from '@/lib/logger';
import { demoOutboxDir } from '@/server/adapters/whatsapp/demo';
import { buildUserContext, type AppCtx } from '@/server/auth/context';
import { createSession, loadSession } from '@/server/auth/session';
import { withTx } from '@/server/db/tx';
import { createDispatchEmailJob } from '@/server/jobs/handlers/dispatch-email';
import type { DispatchRuntimeDeps } from '@/server/jobs/handlers/dispatch-run';
import { createDispatchWhatsAppJob } from '@/server/jobs/handlers/dispatch-whatsapp';
import { createIntegrationHealthJob } from '@/server/jobs/handlers/integration-health';
import { createTemplateSyncJob } from '@/server/jobs/handlers/template-sync';
import { createWaQualityCheckJob } from '@/server/jobs/handlers/wa-quality-check';
import { createStatusApplyJob } from '@/server/jobs/handlers/status-apply';
import type { EmailSeams } from '@/server/adapters/registry';
import type { SmtpSeams } from '@/server/adapters/email/smtp';
import { buildJobRegistry } from '@/server/jobs/registry';
import { contactKey } from '@/server/security/contact-key';
import { credentialAad, encryptSecret, type KeyRing } from '@/server/security/secrets';
import type { LiveAdapterDeps } from '@/server/services/integrations/live-testers';
import { deriveUnsubscribeKey, queueOutboundMessage } from '@/server/services/messaging/dispatch';
import { createWorker, type Worker } from '../../../worker/worker';
import { createTestDb, removeDir, type TestDb } from '../../support/db';
import { FakeGraph } from '../contract/whatsapp-support';

export const NOW = '2026-10-20T06:00:00.000Z';
export const PEPPER = `live-t32-pepper-${'p'.repeat(32)}`;
export const KEY_RING: KeyRing = { activeKid: 'k1', keys: { k1: Buffer.alloc(32, 11) } };
export const PHONE_ID = '109876543210987';
export const WABA_ID = '209876543210987';
export const ACCESS_TOKEN = 'EAAGlivetesttokenZZZZ0000000000000000000000wxyz';
export const GRAPH_VERSION = 'v24.0';

export type LiveHarness = {
  testDb: TestDb;
  db: PrismaClient;
  clock: FixedClock;
  base: string;
  storageDir: string;
  workspaceId: string;
  slug: string;
  ownerId: string;
  memberId: string;
  graph: FakeGraph;
  /** T33: the scripted Resend API and the SMTP seams (mutable: point them at a local server). */
  resend: FakeGraph;
  smtpSeams: SmtpSeams;
  emailSeams: EmailSeams;
  flags: { graphVersion: string | null; keyRing: KeyRing | null };
  deps: () => LiveAdapterDeps;
  owner: () => Promise<AppCtx>;
  member: () => Promise<AppCtx>;
  worker: Worker;
  drain: () => Promise<number>;
  demoOutboxExists: () => boolean;
  destroy: () => Promise<void>;
};

let seq = 0;

export async function createLiveHarness(label: string): Promise<LiveHarness> {
  const testDb = await createTestDb({ label });
  const db = testDb.client();
  const clock = new FixedClock(NOW);
  const base = mkdtempSync(path.join(os.tmpdir(), `auralead-${label}-`));
  const storageDir = path.join(base, 'storage');
  mkdirSync(storageDir, { recursive: true });
  const ws = await db.workspace.create({ data: { slug: 'live-dental-co', name: 'Live Dental Co', mode: 'LIVE', planLabel: 'Growth', timezone: 'Asia/Kolkata' } });
  await db.workspaceSettings.create({ data: { workspaceId: ws.id, maxDiscountBps: 1000, brandColor: '#0F766E', termsText: 'Terms', autoSendEnabled: true } });
  const owner = await db.user.create({ data: { email: 'owner@live-dental.test', name: 'Live Owner', globalRole: 'USER', isDemo: false } });
  await db.membership.create({ data: { userId: owner.id, workspaceId: ws.id, role: 'OWNER' } });
  const member = await db.user.create({ data: { email: 'member@live-dental.test', name: 'Live Member', globalRole: 'USER', isDemo: false } });
  await db.membership.create({ data: { userId: member.id, workspaceId: ws.id, role: 'MEMBER' } });

  const graph = new FakeGraph();
  const resend = new FakeGraph();
  const smtpSeams: SmtpSeams = {};
  const emailSeams: EmailSeams = { resend: { http: resend.http }, smtp: smtpSeams };
  const flags: LiveHarness['flags'] = { graphVersion: GRAPH_VERSION, keyRing: KEY_RING };
  const deps = (): LiveAdapterDeps => ({ keyRing: flags.keyRing, graphVersion: flags.graphVersion, graph: { http: graph.http }, email: emailSeams });
  const runtimeDeps = (): DispatchRuntimeDeps => ({
    contactKeyPepper: PEPPER,
    storageDir,
    appOrigin: 'https://app.example.test',
    unsubscribeKey: deriveUnsubscribeKey('live-t32-session-secret'),
    outboundLockFile: path.join(base, 'outbound.lock'),
    envOutboundPaused: false,
    keyRing: flags.keyRing,
    graphVersion: flags.graphVersion,
  });
  const live = () => 'live' as const;
  const defs = [
    createDispatchWhatsAppJob({ mode: live, deps: runtimeDeps, graph: { http: graph.http } }),
    createDispatchEmailJob({ mode: live, deps: runtimeDeps, emailSeams }),
    createStatusApplyJob({ deps: () => ({ keyRing: flags.keyRing ?? KEY_RING, contactKeyPepper: PEPPER, mode: 'live' }) }),
    createIntegrationHealthJob({ mode: live, deps }),
    createWaQualityCheckJob({ mode: live, deps }),
    createTemplateSyncJob({ mode: live, deps }),
  ];
  const worker = createWorker(
    { db, clock, registry: buildJobRegistry(defs), logger: createLogger({ level: 'silent' }), mode: 'live', version: 'test', random: () => 0 },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
  const drain = async () => {
    let ran = 0;
    while ((await worker.tick()) === 'ran') ran += 1;
    return ran;
  };
  const ctxFor = async (userId: string): Promise<AppCtx> => {
    seq += 1;
    const { token } = await createSession(db, { userId, globalRole: 'USER', mode: 'LIVE', activeWorkspaceId: ws.id, ipHash: 'live', userAgent: 'vitest', now: clock.now() });
    const loaded = (await loadSession(db, token, { now: clock.now(), mode: 'LIVE' }))!;
    return buildUserContext(loaded, { prisma: db, mode: 'live', clock }, { correlationId: `req_t32_live_${String(seq).padStart(4, '0')}` });
  };
  return {
    testDb,
    db,
    clock,
    base,
    storageDir,
    workspaceId: ws.id,
    slug: ws.slug,
    ownerId: owner.id,
    memberId: member.id,
    graph,
    resend,
    smtpSeams,
    emailSeams,
    flags,
    deps,
    owner: () => ctxFor(owner.id),
    member: () => ctxFor(member.id),
    worker,
    drain,
    demoOutboxExists: () => existsSync(demoOutboxDir(storageDir)),
    destroy: async () => {
      await testDb.destroy();
      await removeDir(base);
    },
  };
}

/** A WhatsApp integration stored exactly as the credential writer stores it (envelope + last four). */
export async function storeWhatsApp(h: LiveHarness, opts: { status?: 'CONNECTED' | 'CONFIGURED_UNVERIFIED' | 'DEGRADED' | 'ERROR' | 'REVOKED'; ring?: KeyRing; token?: string; aadIntegrationId?: string } = {}) {
  const existing = await h.db.integration.findFirst({ where: { workspaceId: h.workspaceId, kind: 'WHATSAPP_CLOUD' } });
  const row =
    existing ??
    (await h.db.integration.create({ data: { workspaceId: h.workspaceId, kind: 'WHATSAPP_CLOUD', status: opts.status ?? 'CONNECTED', config: { phoneNumberId: PHONE_ID, wabaId: WABA_ID }, routingKey: PHONE_ID } }));
  const token = opts.token ?? ACCESS_TOKEN;
  const envelope = encryptSecret(opts.ring ?? KEY_RING, token, credentialAad({ workspaceId: h.workspaceId, integrationId: opts.aadIntegrationId ?? row.id, field: 'accessToken' }));
  return h.db.integration.update({
    where: { id: row.id },
    data: { status: opts.status ?? 'CONNECTED', secrets: { accessToken: envelope }, secretLast4: { accessToken: { last4: token.slice(-4), updatedAt: NOW } }, lastErrorCode: null, lastErrorRedacted: null },
  });
}

let leadSeq = 0;
/** A lead with an un-withdrawn WhatsApp marketing opt-in. */
export async function liveLead(h: LiveHarness) {
  leadSeq += 1;
  const name = `Live Lead ${leadSeq}`;
  const phone = `+9198765${String(leadSeq).padStart(5, '0')}`;
  const lead = await h.db.lead.create({
    data: { workspaceId: h.workspaceId, displayName: name, nameNormalized: name.toLowerCase(), phoneE164: phone, alternatePhones: [], scoreReasons: [], unknownInputs: [], firstSource: 'MANUAL' },
  });
  await h.db.consentRecord.create({
    data: {
      workspaceId: h.workspaceId,
      leadId: lead.id,
      contactKey: contactKey(PEPPER, 'phone', phone),
      channel: 'WHATSAPP',
      purpose: 'MARKETING',
      basis: 'OPT_IN',
      source: 'MANUAL_EVIDENCE',
      evidence: { note: 'test evidence' },
      collectedAt: new Date('2026-10-01T00:00:00.000Z'),
      recordedAt: new Date('2026-10-01T00:00:00.000Z'),
    },
  });
  return lead;
}

/** A synced template row (raw provider strings) with its T32 mapping. */
export async function storeTemplate(h: LiveHarness, opts: { name: string; status?: string; components: unknown; buttons?: Record<string, string>; intent?: 'FIRST_TOUCH' | 'QUOTE_READY' | 'FOLLOW_UP' | 'CALL_ACK' | null }) {
  const integration = await h.db.integration.findFirstOrThrow({ where: { workspaceId: h.workspaceId, kind: 'WHATSAPP_CLOUD' } });
  return h.db.whatsAppTemplate.create({
    data: {
      workspaceId: h.workspaceId,
      integrationId: integration.id,
      name: opts.name,
      language: 'en',
      category: 'MARKETING',
      status: opts.status ?? 'APPROVED',
      components: opts.components as object,
      variableSchema: [],
      variableMap: { body: {}, buttons: opts.buttons ?? {} },
      intent: opts.intent ?? null,
      categoryHistory: [],
      syncedAt: h.clock.now(),
    },
  });
}

let dedupe = 0;
/** Queues one outbound WhatsApp message through the outbox (the service the bulk, reply and pipeline callers use). */
export async function queueWhatsApp(h: LiveHarness, ctx: AppCtx, input: { leadId: string; sendIntent: 'MANUAL_SINGLE' | 'AUTOMATED'; templateId?: string; variables?: Record<string, string>; body?: string }) {
  dedupe += 1;
  return withTx(ctx.db, (tx) =>
    queueOutboundMessage(
      tx,
      ctx,
      {
        kind: input.templateId ? 'TEMPLATE' : 'TEXT',
        templateId: input.templateId ?? null,
        variables: input.variables ?? null,
        body: input.body ?? null,
        leadId: input.leadId,
        channel: 'WHATSAPP',
        sendIntent: input.sendIntent,
        initiatedBy: input.sendIntent === 'AUTOMATED' ? 'system:test' : ctx.actor!.userId,
        dedupeKey: `t32-live:${dedupe}`,
      },
      { contactKeyPepper: PEPPER },
    ),
  );
}

export const SIMPLE_TEMPLATE = [
  { type: 'BODY', text: 'Namaste {{1}}, thank you for your interest in {{2}}.' },
  { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Get a quote' }, { type: 'QUICK_REPLY', text: 'Stop' }] },
];
