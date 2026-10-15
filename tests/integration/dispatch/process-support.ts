/**
 * Helpers for the T19 multi-process tests (lease-expiry-send, worker-restart): spawn the dispatch
 * worker fixture (production boot, production DEMO transport), and queue one approved WhatsApp
 * template send whose timestamps lie in the past, so a worker on wall-clock (or offset) time can
 * claim and preflight it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { readDemoOutbox, demoOutboxDir } from '@/server/adapters/whatsapp/demo';
import { approveAndSendMessage, createMessageDraft } from '@/server/services/messaging/dispatch';
import { seedDemo } from '../../../prisma/seed/seed';
import { spawnTsx, type SpawnedNode } from '../../support/spawn';
import { createTestDb, removeDir, type TestDb } from '../../support/db';
import { userCtx } from '../quotes/support';
import { approvedTemplate, createLead, grantConsent, PEPPER } from './support';

export const DISPATCH_WORKER = path.resolve(import.meta.dirname, 'fixtures', 'dispatch-worker.ts');
const TEST_TOKEN = 'test-control-token-for-dispatch-tests';
/** Everything is created at this instant, well before the worker's clock. */
export const PAST = '2026-01-05T06:00:00.000Z';

export type ProcessHarness = { testDb: TestDb; db: PrismaClient; base: string; storageDir: string; pauseDir: string; destroy: () => Promise<void> };

export async function createProcessHarness(label: string): Promise<ProcessHarness> {
  const testDb = await createTestDb({ label });
  const db = testDb.client();
  await seedDemo(db, { config: { mode: 'demo' }, now: new Date('2026-01-01T00:00:00.000Z') });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `auralead-${label}-`));
  const storageDir = path.join(base, 'storage');
  const pauseDir = path.join(base, 'pause');
  fs.mkdirSync(storageDir, { recursive: true });
  fs.mkdirSync(pauseDir, { recursive: true });
  return {
    testDb,
    db,
    base,
    storageDir,
    pauseDir,
    destroy: async () => {
      await testDb.destroy();
      await removeDir(base);
    },
  };
}

export function spawnDispatchWorker(h: ProcessHarness, opts: { name: string; pausePoints?: string[]; tuning?: Record<string, unknown> }): SpawnedNode {
  return spawnTsx(DISPATCH_WORKER, {
    env: {
      DATABASE_URL: h.testDb.url,
      APP_MODE: 'demo',
      NEXT_PUBLIC_APP_MODE: undefined,
      STORAGE_DIR: h.storageDir,
      AURALEAD_DATA_DIR: path.join(h.base, 'data'),
      SUPPRESSION_PEPPER: PEPPER,
      SESSION_SECRET: 'dispatch-process-test-session-secret-0123456789',
      OUTBOUND_PAUSED: '0',
      AURALEAD_TEST_CONTROL: '1',
      TEST_CONTROL_TOKEN: TEST_TOKEN,
      LOG_LEVEL: 'warn',
      NODE_ENV: 'test',
      WORKER_TUNING: JSON.stringify({ idlePollMs: 50, ...(opts.tuning ?? {}) }),
      AURALEAD_PAUSE_DIR: opts.pausePoints ? h.pauseDir : undefined,
      AURALEAD_PAUSE_AT: opts.pausePoints?.join(','),
    },
  });
}

/** One APPROVED WhatsApp template message to an opted-in lead, queued as approve-and-send would. */
export async function queueTemplateSend(h: ProcessHarness) {
  const clock = new FixedClock(PAST);
  const lead = await createLead(h.db);
  await grantConsent(h.db, lead, 'WHATSAPP', 'OPT_IN', new Date('2026-01-02T00:00:00.000Z'));
  const template = await approvedTemplate(h.db, lead.workspaceId, 'appointment_reminder');
  const owner = await userCtx(h.db, clock, 'owner');
  const draft = await createMessageDraft(owner, { leadId: lead.id, channel: 'WHATSAPP', kind: 'TEMPLATE', templateId: template.id, variables: { '1': 'Monday 10:00' } }, { contactKeyPepper: PEPPER });
  return approveAndSendMessage(owner, { messageId: draft.messageId }, { contactKeyPepper: PEPPER });
}

export function waOutbox(h: ProcessHarness) {
  return readDemoOutbox(demoOutboxDir(h.storageDir), 'WHATSAPP');
}
