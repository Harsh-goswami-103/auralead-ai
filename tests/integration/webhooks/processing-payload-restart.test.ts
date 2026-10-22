// E1 / ADR-35 (T11): a webhook event keeps two payloads. `payloadRedacted` is the inspector view
// and holds no contact data; `processingPayload` is the full parsed body encrypted under the
// credentials key ring with AAD = the event id, so a worker that dies between persist and process
// loses nothing: the next worker decrypts it and creates the lead with the right phone and email.
// The ciphertext is bound to its event (another event id fails to decrypt it), and `webhook.purge`
// nulls it once processing succeeded plus the 7-day retention window, never earlier.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { getWebhookContext } from '@/server/auth/context';
import { decryptSecretString, SecretDecryptError, webhookPayloadAad } from '@/server/security/secrets';
import { canonicalJson, decryptProcessingPayload, persistWebhookEvent, PROCESSED_RETENTION_MS, sha256Hex } from '@/server/services/webhooks/events';
import { ensureSimulatedSheets } from '@/server/services/webhooks/simulate';
import { spawnTsx, terminate, terminateAll, type SpawnedNode } from '../../support/spawn';
import { makePauseDir, setTestClockOffset, waitFor, waitPaused } from '../jobs/support';
import { createHarness, WS_A, type Harness } from './support';
import path from 'node:path';

const WORKER = path.resolve(import.meta.dirname, 'fixtures', 'ingest-worker.ts');
// Before any real "now", so the spawned workers (system clock + test offset) can claim the job.
const PAST = '2026-01-01T00:00:00.000Z';

const PHONE_RAW = '+91 98111 23456';
const PHONE_E164 = '+919811123456';
const EMAIL = 'Priya.Natarajan@Clinic-Leads.in';

let h: Harness;
let db: PrismaClient;

beforeAll(async () => {
  h = await createHarness('processing-payload-restart', { now: PAST });
  db = h.db;
});
afterAll(async () => {
  await terminateAll();
  await h?.destroy();
});

function spawnWorker(name: string, pause?: { dir: string; points: string[] }): SpawnedNode {
  return spawnTsx(WORKER, {
    env: {
      DATABASE_URL: h.testDb.url,
      APP_MODE: 'demo',
      NEXT_PUBLIC_APP_MODE: 'demo',
      AURALEAD_TEST_CONTROL: '1',
      TEST_CONTROL_TOKEN: 'test-control-token-for-webhook-restart',
      SESSION_SECRET: h.config.secrets.sessionSecret!,
      SHARE_NONCE_KEY: h.config.secrets.shareNonceKey!,
      SUPPRESSION_PEPPER: h.config.secrets.suppressionPepper!,
      CREDENTIALS_KEYRING: JSON.stringify(Object.fromEntries(Object.entries(h.deps.keyRing.keys).map(([kid, key]) => [kid, key.toString('base64')]))),
      CREDENTIALS_ACTIVE_KID: h.deps.keyRing.activeKid,
      LOG_LEVEL: 'warn',
      NODE_ENV: 'test',
      WORKER_NAME: name,
      WORKER_TUNING: JSON.stringify({ idlePollMs: 50, backoff: { baseMs: 100, capMs: 1_000, jitterRatio: 0 } }),
      AURALEAD_PAUSE_DIR: pause?.dir,
      AURALEAD_PAUSE_AT: pause?.points.join(','),
    },
  });
}

async function persistSheetRow(externalKey: string, rowKey: string, contact = { name: 'Priya Natarajan', phone: PHONE_RAW, email: EMAIL }) {
  const ctx = getWebhookContext({ workspaceId: WS_A }, { prisma: db, mode: 'demo', clock: h.clock }, `req_e1_${externalKey}`);
  const sheets = await ensureSimulatedSheets(ctx);
  const body = {
    version: 1,
    eventId: externalKey,
    sheetId: 'sheet-e1',
    mappingVersion: sheets.mappingVersion,
    rows: [
      {
        rowKey,
        submittedAt: '2025-12-31T18:30:00.000Z',
        values: { [sheets.fieldMap.name!]: contact.name, [sheets.fieldMap.phone!]: contact.phone, [sheets.fieldMap.email!]: contact.email, [sheets.fieldMap.city!]: 'Chennai' },
      },
    ],
  };
  const persisted = await persistWebhookEvent(
    db,
    ctx,
    { provider: 'GOOGLE_SHEETS', workspaceId: WS_A, integrationId: sheets.integrationId, externalKey, body, bodySha256: sha256Hex(canonicalJson(body)), simulated: false, processJob: 'ingest.process' },
    { keyRing: h.deps.keyRing },
  );
  return { persisted, body };
}

describe('encrypted processing payload (E1)', () => {
  it('stores no contact data in the redacted view and binds the ciphertext to its event id', async () => {
    const { persisted, body } = await persistSheetRow('evt-e1-view', 'row-view', { name: 'Farhan Khan', phone: '+91 99100 45678', email: 'farhan.khan@clinic-leads.in' });
    const other = await persistSheetRow('evt-e1-other', 'row-other', { name: 'Zoya Desai', phone: '+91 98200 56789', email: 'zoya.desai@clinic-leads.in' });
    const event = await db.webhookEvent.findUniqueOrThrow({ where: { id: persisted.eventId } });
    const otherEvent = await db.webhookEvent.findUniqueOrThrow({ where: { id: other.persisted.eventId } });

    const view = JSON.stringify(event.payloadRedacted);
    expect(view).not.toContain('99100');
    expect(view).not.toContain('45678');
    expect(view.toLowerCase()).not.toContain('farhan.khan@clinic-leads.in');
    expect(view).toContain('[REDACTED]');
    expect(event.bodySha256).toBe(sha256Hex(canonicalJson(body)));

    expect(event.processingPayload).toMatch(/^v1\./);
    expect(event.processingPayload).not.toContain('99100');
    expect(decryptProcessingPayload(h.deps.keyRing, event)).toEqual(body);
    // Same ring, another event's id as AAD: authentication fails.
    let error: unknown = null;
    try {
      decryptSecretString(h.deps.keyRing, event.processingPayload!, webhookPayloadAad(otherEvent.id));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SecretDecryptError);
    expect((error as SecretDecryptError).reason).toBe('AUTH_FAILED');
    // Swapping ciphertexts between rows does not decrypt either.
    expect(() => decryptProcessingPayload(h.deps.keyRing, { id: event.id, processingPayload: otherEvent.processingPayload })).toThrow(SecretDecryptError);

    // Process both in-process so the restart test below starts with an empty queue.
    await h.drain();
    expect((await db.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('PROCESSED');
  });

  it('a worker killed before processing loses nothing: the next worker creates the lead with the right phone and email', async () => {
    const { persisted } = await persistSheetRow('evt-e1-restart', 'row-restart');
    expect(persisted.outcome).toBe('ACCEPTED');
    const pauseDir = await makePauseDir(h.testDb.dir);

    // Worker A claims the ingest job and is killed before running it.
    const a = spawnWorker('A', { dir: pauseDir, points: ['job.claimed'] });
    await a.waitForLine((l) => l === 'READY', 60_000);
    await waitPaused(pauseDir, 'job.claimed', 60_000);
    const claimed = await db.job.findUniqueOrThrow({ where: { id: persisted.jobId! } });
    expect(claimed.status).toBe('RUNNING');
    await terminate(a);
    expect(await db.lead.count({ where: { workspaceId: WS_A, phoneE164: PHONE_E164 } })).toBe(0);
    expect((await db.webhookEvent.findUniqueOrThrow({ where: { id: persisted.eventId } })).status).toBe('RECEIVED');

    // Restart: past A's lease, worker B reclaims and processes from the encrypted payload.
    await setTestClockOffset(db, 120_000);
    const b = spawnWorker('B');
    await b.waitForLine((l) => l === 'READY', 60_000);
    await waitFor(async () => (await db.webhookEvent.findUniqueOrThrow({ where: { id: persisted.eventId } })).status === 'PROCESSED', 60_000, 'B processes the event');
    b.send('STOP');
    await b.waitForExit(40_000);

    const job = await db.job.findUniqueOrThrow({ where: { id: persisted.jobId! } });
    expect(job).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
    const leads = await db.lead.findMany({ where: { workspaceId: WS_A, phoneE164: PHONE_E164 } });
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ displayName: 'Priya Natarajan', emailNormalized: EMAIL.toLowerCase(), city: 'Chennai', firstSource: 'GOOGLE_SHEETS' });

    // Processing never wrote contact data into the inspector view or the stored result.
    const event = await db.webhookEvent.findUniqueOrThrow({ where: { id: persisted.eventId } });
    expect(JSON.stringify(event.payloadRedacted)).not.toContain('98111');
    expect(JSON.stringify(event.result)).not.toContain('98111');
    expect(JSON.stringify(event.result).toLowerCase()).not.toContain(EMAIL.toLowerCase());
    expect(event.processingPayload).not.toBeNull();
  });

  it('webhook.purge nulls the processing payload after processing plus the retention window, not before', async () => {
    const event = await db.webhookEvent.findFirstOrThrow({ where: { externalKey: 'evt-e1-restart' } });
    expect(event.status).toBe('PROCESSED');
    const processedAt = event.processedAt!;
    const purgeJob = await db.job.findUniqueOrThrow({ where: { idempotencyKey: `webhook.purge:${event.id}` } });
    expect(purgeJob.runAt.getTime()).toBe(processedAt.getTime() + PROCESSED_RETENTION_MS);
    expect(PROCESSED_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);

    // An early purge request (e.g. a duplicate scheduler) defers to the due time and keeps the payload.
    await db.job.create({
      data: {
        workspaceId: WS_A,
        type: 'webhook.purge',
        payload: { webhookEventId: event.id },
        runAt: new Date(processedAt.getTime() + 60_000),
        idempotencyKey: `webhook.purge:early:${event.id}`,
        correlationId: 'req_e1_early_purge',
      },
    });
    h.clock.set(new Date(processedAt.getTime() + 120_000));
    await h.drain();
    const early = await db.job.findUniqueOrThrow({ where: { idempotencyKey: `webhook.purge:early:${event.id}` } });
    expect(early.status).toBe('QUEUED');
    expect(early.runAt.getTime()).toBe(processedAt.getTime() + PROCESSED_RETENTION_MS);
    expect((await db.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).processingPayload).not.toBeNull();

    // One millisecond short of the window: still kept.
    h.clock.set(new Date(processedAt.getTime() + PROCESSED_RETENTION_MS - 1));
    await h.drain();
    expect((await db.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).processingPayload).not.toBeNull();

    // At the window: purged, the redacted view and the stored result stay for the inspector.
    h.clock.set(new Date(processedAt.getTime() + PROCESSED_RETENTION_MS));
    await h.drain();
    const purged = await db.webhookEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(purged.processingPayload).toBeNull();
    expect(purged.processingPurgedAt?.getTime()).toBe(processedAt.getTime() + PROCESSED_RETENTION_MS);
    expect(purged.payloadRedacted).toEqual(event.payloadRedacted);
    expect(purged.result).toEqual(event.result);
    expect(purged.status).toBe('PROCESSED');
    expect((await db.job.findUniqueOrThrow({ where: { id: purgeJob.id } })).status).toBe('SUCCEEDED');
    expect(await db.auditEvent.count({ where: { action: 'webhook.purge', targetId: event.id } })).toBe(1);
  });
});
