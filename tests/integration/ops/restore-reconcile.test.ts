/**
 * O1, E8, R42 (T24): `db:backup` (VACUUM INTO) and `db:restore`, against the real T18/T20 journal
 * producer (the WhatsApp webhook route's synchronous Stop and the START re-opt-in exported by the
 * reconcile job), never a fixture journal. One data dir, so the routes, the reconcile job and the
 * restore share `config.paths.journalDir` exactly as in the app.
 *
 * Sequence: a send is queued, then the backup is taken; after the backup that send goes out, lead
 * A sends STOP, lead B sends STOP then START. Restore then:
 *  - writes `outbound.lock` first and keeps outbound paused (lock + SystemSetting) until an
 *    operator resumes;
 *  - turns the pre-backup non-terminal attempt (QUEUED in the backup, really sent later) into
 *    AMBIGUOUS, its job DEAD(AMBIGUOUS) and its message "Delivery unknown", so it is never resent;
 *  - replays the journal entries newer than the backup in order: lead A suppressed again, lead B's
 *    STOP then CLEAR ends cleared with the journaled consent id; a Stop older than the backup is
 *    not duplicated;
 *  - 0 sends until the operator resumes; after the resume a new send goes out and the AMBIGUOUS one
 *    still does not.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import type { AppConfig } from '@/lib/config';
import { createLogger } from '@/lib/logger';
import type { WaSendRequest, WhatsAppTransport } from '@/server/adapters/whatsapp/port';
import { POST as pausePost } from '@/app/api/admin/system/outbound-pause/route';
import { createDispatchWhatsAppJob } from '@/server/jobs/handlers/dispatch-whatsapp';
import { createStatusApplyJob } from '@/server/jobs/handlers/status-apply';
import { createSuppressionJournalReconcileJob } from '@/server/jobs/handlers/suppression-journal-reconcile';
import { createWebhookProcessJob } from '@/server/jobs/handlers/webhook-process';
import { buildJobRegistry } from '@/server/jobs/registry';
import { createBackup, readBackupManifest, restoreBackup, RESTORE_LOCK_WRITER } from '@/server/services/admin/backup';
import { readOutboundPause } from '@/server/services/admin/outbound-pause';
import { approveAndSendMessage, createMessageDraft, deriveUnsubscribeKey } from '@/server/services/messaging/dispatch';
import type { InboundDeps } from '@/server/services/messaging/inbound';
import { readJournal } from '@/server/services/messaging/suppression-journal';
import { seedDemo } from '../../../prisma/seed/seed';
import { createWorker } from '../../../worker/worker';
import { createTestDb, removeDir, type TestDb } from '../../support/db';
import { testConfig, uninstallRuntime, useRuntime } from '../auth/support';
import { approvedTemplate, createLead, DEPS, grantConsent, PEPPER, ScriptedTransport, SEED_NOW, WS_A } from '../dispatch/support';
import { APP_SECRET, inbound, PNID_A, phoneKey, SESSION_SECRET, VERIFY_TOKEN } from '../messaging/inbound-support';
import { userCtx } from '../quotes/support';
import { adminSession, callRoute } from '../admin/support';

let testDb: TestDb;
let db: PrismaClient;
let config: AppConfig;
let dataDir: string;
const clock = new FixedClock('2026-10-16T06:00:00.000Z');
let wa: ScriptedTransport<WaSendRequest> & WhatsAppTransport;
let drain: () => Promise<number>;

beforeAll(async () => {
  testDb = await createTestDb({ label: 'restore-reconcile' });
  db = testDb.client();
  await seedDemo(db, { config: { mode: 'demo' }, now: SEED_NOW });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auralead-data-restore-'));
  config = testConfig('demo', { AURALEAD_DATA_DIR: dataDir, SUPPRESSION_PEPPER: PEPPER, META_APP_SECRET: APP_SECRET, META_VERIFY_TOKEN: VERIFY_TOKEN, SESSION_SECRET });
  fs.mkdirSync(config.paths.storageDir, { recursive: true });
  useRuntime(db, config, clock);
  await db.integration.create({ data: { workspaceId: WS_A, kind: 'WHATSAPP_CLOUD', status: 'CONNECTED', config: { phoneNumberId: PNID_A }, routingKey: PNID_A } });

  wa = new ScriptedTransport<WaSendRequest>(clock) as ScriptedTransport<WaSendRequest> & WhatsAppTransport;
  const inboundDeps: InboundDeps = { keyRing: config.secrets.credentials!, contactKeyPepper: PEPPER, mode: 'demo' };
  const runtimeDeps = () => ({
    contactKeyPepper: PEPPER,
    storageDir: config.paths.storageDir,
    appOrigin: config.appOrigin,
    unsubscribeKey: deriveUnsubscribeKey(SESSION_SECRET),
    outboundLockFile: config.paths.outboundLockFile,
    envOutboundPaused: false,
  });
  const defs = [
    createDispatchWhatsAppJob({ mode: () => 'demo', deps: runtimeDeps, whatsapp: () => wa }),
    createWebhookProcessJob({ deps: () => inboundDeps }),
    createStatusApplyJob({ deps: () => inboundDeps }),
    createSuppressionJournalReconcileJob({ deps: () => ({ journalDir: config.paths.journalDir }) }),
  ];
  const worker = createWorker(
    { db, clock, registry: buildJobRegistry(defs), logger: createLogger({ level: 'silent' }), mode: 'demo', version: 'test', random: () => 0 },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
  drain = async () => {
    let ran = 0;
    while ((await worker.tick()) === 'ran') ran += 1;
    return ran;
  };
}, 120_000);

afterAll(async () => {
  uninstallRuntime();
  await testDb?.destroy();
  if (dataDir) await removeDir(dataDir);
});

async function eligible() {
  const lead = await createLead(db);
  await grantConsent(db, lead, 'WHATSAPP');
  return lead;
}

async function queueSend(leadId: string) {
  const owner = await userCtx(db, clock, 'owner');
  const template = await approvedTemplate(db);
  const draft = await createMessageDraft(owner, { leadId, channel: 'WHATSAPP', kind: 'TEMPLATE', templateId: template.id, variables: { '1': 'Asha' } }, DEPS);
  return approveAndSendMessage(owner, { messageId: draft.messageId }, DEPS);
}

const activeRows = (key: string) => db.suppression.findMany({ where: { workspaceId: WS_A, channel: 'WHATSAPP', contactKey: key, clearedAt: null } });

describe('backup and restore with SuppressionJournal replay', () => {
  it('restores, reconciles in-flight attempts to AMBIGUOUS, replays the journal and stays paused until resumed', async () => {
    // Before the backup: lead D stopped (in the backup), and a send for lead A queued but not run.
    const leadD = await eligible();
    expect((await inbound(leadD, { text: 'STOP' }, clock.now())).res.status).toBe(200);
    const leadA = await eligible();
    const leadB = await eligible();
    const queued = await queueSend(leadA.id);

    clock.advance(60_000);
    const backup = await createBackup(db, clock, { backupDir: config.paths.backupDir, mode: 'demo', correlationId: 'test-backup' });
    const backupAt = clock.now();
    expect(fs.existsSync(backup.file)).toBe(true);
    const manifest = await readBackupManifest(backup.manifestFile);
    expect(manifest).toMatchObject({ format: 1, mode: 'demo', backupAt: backupAt.toISOString(), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(manifest.migrations.length).toBeGreaterThan(0);

    // After the backup: the queued send goes out, A stops, B stops and opts back in with START.
    clock.advance(60_000);
    await drain();
    expect(wa.calls.map((c) => c.request.attemptId)).toEqual([queued.attemptId]);
    clock.advance(60_000);
    expect((await inbound(leadA, { text: 'STOP' }, clock.now())).res.status).toBe(200);
    expect((await inbound(leadB, { text: 'STOP' }, clock.now())).res.status).toBe(200);
    clock.advance(60_000);
    expect((await inbound(leadB, { text: 'START' }, clock.now())).res.status).toBe(200);
    await drain();
    const liveA = (await activeRows(phoneKey(leadA.phoneE164!)))[0]!;
    const liveB = await db.suppression.findFirstOrThrow({ where: { workspaceId: WS_A, contactKey: phoneKey(leadB.phoneE164!) } });
    expect(liveB.clearedAt).not.toBeNull();
    const journal = await readJournal(config.paths.journalDir);
    const after = journal.filter((e) => new Date(e.createdAt) > backupAt);
    expect(after.map((e) => `${e.suppressionId}:${e.action}`)).toEqual([`${liveA.id}:STOP`, `${liveB.id}:STOP`, `${liveB.id}:CLEAR`]);
    const callsBeforeRestore = wa.calls.length;

    // Restore (the web and worker would be stopped; this test's worker is idle).
    clock.advance(60_000);
    const restoreClient = testDb.client();
    const result = await restoreBackup(restoreClient, clock, {
      manifestFile: backup.manifestFile,
      lockFile: config.paths.outboundLockFile,
      journalDir: config.paths.journalDir,
      mode: 'demo',
      correlationId: 'test-restore',
    });
    await restoreClient.$disconnect();
    expect(result).toMatchObject({ backupAt: backupAt.toISOString(), attemptsMadeAmbiguous: 1, journal: { replayed: 3, stopsInserted: 2, clearsApplied: 1 } });

    // outbound.lock written by the restore and the DB pause both hold.
    expect(fs.existsSync(config.paths.outboundLockFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(config.paths.outboundLockFile, 'utf8'))).toMatchObject({ writtenBy: RESTORE_LOCK_WRITER });
    const pause = await readOutboundPause(db, { lockFile: config.paths.outboundLockFile, envPaused: false });
    expect(pause).toMatchObject({ paused: true, db: { paused: true }, lockFile: { present: true, writtenByRestore: true } });

    // The send that was QUEUED in the backup (and really went out later) is AMBIGUOUS, never resent.
    expect(await db.dispatchAttempt.findUniqueOrThrow({ where: { id: queued.attemptId } })).toMatchObject({ state: 'AMBIGUOUS', reasonCode: 'RESTORED_IN_FLIGHT' });
    expect(await db.job.findUniqueOrThrow({ where: { id: queued.jobId } })).toMatchObject({ status: 'DEAD', deadReason: 'AMBIGUOUS', retrySafe: false });
    expect(await db.message.findUniqueOrThrow({ where: { id: queued.messageId } })).toMatchObject({ status: 'UNKNOWN' });

    // Journal replay: A suppressed under the journaled id, B cleared with the journaled consent, D not duplicated.
    expect((await activeRows(phoneKey(leadA.phoneE164!))).map((r) => r.id)).toEqual([liveA.id]);
    const restoredB = await db.suppression.findMany({ where: { workspaceId: WS_A, contactKey: phoneKey(leadB.phoneE164!) } });
    expect(restoredB).toHaveLength(1);
    expect(restoredB[0]).toMatchObject({ id: liveB.id, clearedByConsentId: liveB.clearedByConsentId });
    expect(restoredB[0]!.clearedAt?.toISOString()).toBe(liveB.clearedAt!.toISOString());
    expect(await db.suppression.count({ where: { workspaceId: WS_A, contactKey: phoneKey(leadD.phoneE164!) } })).toBe(1);
    expect(await db.auditEvent.count({ where: { action: 'ops.restore' } })).toBe(1);

    // 0 sends until an operator resumes.
    const leadC = await eligible();
    const fresh = await queueSend(leadC.id);
    for (let i = 0; i < 3; i += 1) {
      clock.advance(61_000);
      await drain();
    }
    expect(wa.calls).toHaveLength(callsBeforeRestore);
    expect(await db.dispatchAttempt.findUniqueOrThrow({ where: { id: fresh.attemptId } })).toMatchObject({ state: 'QUEUED' });

    // The operator resumes (admin route): the restore lock is removed with the DB flag.
    const admin = await adminSession({ db, clock, config });
    const resumed = await callRoute(pausePost, '/api/admin/system/outbound-pause', admin, { body: { paused: false, reason: 'Restore reviewed; AMBIGUOUS attempts checked with the provider' } });
    expect(resumed.status).toBe(200);
    expect(fs.existsSync(config.paths.outboundLockFile)).toBe(false);
    clock.advance(61_000);
    await drain();
    expect(wa.calls.map((c) => c.request.attemptId)).toEqual([queued.attemptId, fresh.attemptId]);
  });

  it('refuses a backup of the other mode and a tampered backup file, and leaves no lock behind', async () => {
    const backup = await createBackup(db, clock, { backupDir: config.paths.backupDir, mode: 'demo', correlationId: 'test-backup-2' });
    await expect(
      restoreBackup(db, clock, { manifestFile: backup.manifestFile, lockFile: config.paths.outboundLockFile, journalDir: config.paths.journalDir, mode: 'live', correlationId: 'x' }),
    ).rejects.toThrow(/mode/i);
    expect(fs.existsSync(config.paths.outboundLockFile)).toBe(false);
    fs.appendFileSync(backup.file, Buffer.from('tamper'));
    await expect(
      restoreBackup(db, clock, { manifestFile: backup.manifestFile, lockFile: config.paths.outboundLockFile, journalDir: config.paths.journalDir, mode: 'demo', correlationId: 'x' }),
    ).rejects.toThrow(/sha256/i);
    expect(fs.existsSync(config.paths.outboundLockFile)).toBe(false);
  });

  it('refuses while a worker heartbeat is fresh', async () => {
    const backup = await createBackup(db, clock, { backupDir: config.paths.backupDir, mode: 'demo', correlationId: 'test-backup-3' });
    await db.workerHeartbeat.upsert({
      where: { workerId: 'live-worker' },
      create: { workerId: 'live-worker', pid: 1, hostname: 'h', version: 't', mode: 'DEMO', startedAt: clock.now(), lastBeatAt: clock.now() },
      update: { lastBeatAt: clock.now() },
    });
    await expect(
      restoreBackup(db, clock, { manifestFile: backup.manifestFile, lockFile: config.paths.outboundLockFile, journalDir: config.paths.journalDir, mode: 'demo', correlationId: 'x' }),
    ).rejects.toThrow(/worker/i);
    expect(fs.existsSync(config.paths.outboundLockFile)).toBe(false);
  });
});
