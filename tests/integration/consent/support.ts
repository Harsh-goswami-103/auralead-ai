/**
 * Shared harness for the T18 consent, eligibility and suppression tests: the seeded DEMO DB, a temp
 * SuppressionJournal directory, the fixed contact-key pepper, contexts (webhook-style for ingestion
 * and inbound events, real user sessions for the consent routes), leads, a WhatsApp integration
 * with templates, and an in-process worker with the journal reconcile job.
 */
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Channel, PrismaClient } from '@/generated/prisma/client';
import { createLogger } from '@/lib/logger';
import { getWebhookContext, type AppCtx } from '@/server/auth/context';
import { buildJobRegistry } from '@/server/jobs/registry';
import { createSuppressionJournalReconcileJob } from '@/server/jobs/handlers/suppression-journal-reconcile';
import type { SuppressionDeps } from '@/server/services/messaging/suppression';
import type { JournalEntry } from '@/server/services/messaging/suppression-journal';
import { createWorker, type Worker } from '../../../worker/worker';
import { removeDir } from '../../support/db';
import { createIngestHarness, PEPPER, WS_A, type IngestHarness } from '../ingest/support';

export { PEPPER, WS_A };
export const NOW = '2026-10-16T06:00:00.000Z';

export type ConsentHarness = IngestHarness & { journalDir: string; deps: SuppressionDeps; cleanup: () => Promise<void> };

export async function createConsentHarness(label: string): Promise<ConsentHarness> {
  const h = await createIngestHarness(label);
  const base = await mkdtemp(path.join(os.tmpdir(), `auralead-journal-${label}-`));
  const journalDir = path.join(base, 'journal');
  h.clock.set(NOW);
  return {
    ...h,
    journalDir,
    deps: { contactKeyPepper: PEPPER, journalDir },
    cleanup: async () => {
      await h.testDb.destroy();
      await removeDir(base);
    },
  };
}

let seq = 0;
export function wsCtx(h: Pick<IngestHarness, 'db' | 'clock'>, workspaceId: string = WS_A, mode: 'demo' | 'live' = 'demo'): AppCtx {
  seq += 1;
  return getWebhookContext({ workspaceId }, { prisma: h.db, mode, clock: h.clock }, `req_consent_test_${String(seq).padStart(4, '0')}`);
}

let leadSeq = 0;
export async function createLead(db: PrismaClient, opts: { workspaceId?: string; phone?: string | null; email?: string | null; source?: 'GOOGLE_SHEETS' | 'GMAPS_EXTENSION' | 'MANUAL' } = {}) {
  leadSeq += 1;
  const name = `Consent Lead ${leadSeq}`;
  return db.lead.create({
    data: {
      workspaceId: opts.workspaceId ?? WS_A,
      displayName: name,
      nameNormalized: name.toLowerCase(),
      phoneE164: opts.phone === undefined ? `+9198110${String(leadSeq).padStart(5, '0')}` : opts.phone,
      emailNormalized: opts.email ?? null,
      alternatePhones: [],
      scoreReasons: [],
      unknownInputs: [],
      firstSource: opts.source ?? 'MANUAL',
    },
  });
}

/** A WhatsApp Cloud integration with one APPROVED and one PENDING template (raw provider strings). */
export async function ensureWhatsApp(db: PrismaClient, workspaceId: string = WS_A, status: 'SIMULATED' | 'CONNECTED' = 'SIMULATED') {
  const existing = await db.integration.findFirst({ where: { workspaceId, kind: 'WHATSAPP_CLOUD' } });
  const integration = existing ?? (await db.integration.create({ data: { workspaceId, kind: 'WHATSAPP_CLOUD', status, config: {} } }));
  const template = async (name: string, tStatus: string) =>
    (await db.whatsAppTemplate.findFirst({ where: { integrationId: integration.id, name } })) ??
    db.whatsAppTemplate.create({
      data: {
        workspaceId,
        integrationId: integration.id,
        name,
        language: 'en',
        category: 'MARKETING',
        status: tStatus,
        components: [],
        variableSchema: [],
        variableMap: {},
        categoryHistory: [],
        syncedAt: new Date(NOW),
      },
    });
  return { integration, approved: await template('first_touch', 'APPROVED'), pending: await template('follow_up', 'PENDING') };
}

export function reconcileWorker(h: ConsentHarness): Worker {
  return createWorker(
    {
      db: h.db,
      clock: h.clock,
      registry: buildJobRegistry([createSuppressionJournalReconcileJob({ deps: () => ({ journalDir: h.journalDir }) })]),
      logger: createLogger({ level: 'silent' }),
      mode: 'demo',
      version: 'test',
      random: () => 0,
    },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
}

export async function drain(w: Worker): Promise<void> {
  while ((await w.tick()) === 'ran');
}

/** Every journal line in file order (files sorted by name). */
export async function journalLines(dir: string): Promise<JournalEntry[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
  const out: JournalEntry[] = [];
  for (const f of files) {
    const text = await readFile(path.join(dir, f), 'utf8');
    for (const line of text.split('\n')) if (line.trim() !== '') out.push(JSON.parse(line) as JournalEntry);
  }
  return out;
}

export async function suppressionRows(db: PrismaClient, contactKey: string, channel: Channel = 'WHATSAPP') {
  return db.suppression.findMany({ where: { workspaceId: WS_A, contactKey, channel }, orderBy: { createdAt: 'asc' } });
}
