/**
 * E5 / ADR-39: fenceJob is a write-first claimToken check. With a matching token on a RUNNING job
 * it bumps updatedAt; otherwise it throws LeaseLostError and the enclosing transaction rolls back
 * before any domain write commits.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { claimNextJob } from '@/server/db/raw/claim-job';
import { fenceJob, LeaseLostError } from '@/server/db/fence';
import { withTx } from '@/server/db/tx';
import { createTestDb, type TestDb } from '../../support/db';
import { at, createJob, createTenantGraph, type TenantGraph } from './fixtures';

let testDb: TestDb;
let db: PrismaClient;
let a: TenantGraph;

beforeAll(async () => {
  testDb = await createTestDb({ label: 'fence' });
  db = testDb.client();
  a = await createTenantGraph(db, 'alpha');
});

afterAll(async () => {
  await testDb?.destroy();
});

describe('fenceJob', () => {
  it('passes for the current claim and bumps updatedAt', async () => {
    await createJob(db, 'fence-ok', a.workspaceId);
    const claimed = await claimNextJob(db, { now: at(1), leaseUntil: at(2), claimToken: 'tok-ok' });
    expect(claimed?.idempotencyKey).toBe('fence-ok');

    await withTx(db, async (tx) => {
      await fenceJob(tx, claimed!.id, 'tok-ok', at(1.5));
      await tx.service.create({ data: { workspaceId: a.workspaceId, code: 'FENCED', name: 'n', description: 'd', unitLabel: 'u' } });
    });

    const job = await db.job.findUniqueOrThrow({ where: { id: claimed!.id } });
    expect(job.updatedAt.toISOString()).toBe(at(1.5).toISOString());
    expect(await db.service.count({ where: { code: 'FENCED' } })).toBe(1);
    await db.job.update({ where: { id: claimed!.id }, data: { status: 'SUCCEEDED' } });
  });

  it('throws LeaseLostError for a stale token and rolls back the domain write', async () => {
    await createJob(db, 'fence-stale', a.workspaceId);
    const first = await claimNextJob(db, { now: at(10), leaseUntil: at(11), claimToken: 'tok-A' });
    // Lease expires; the reaper requeues and worker B reclaims with a new token.
    await db.job.update({ where: { id: first!.id }, data: { status: 'QUEUED', claimToken: null, leaseUntil: null } });
    const second = await claimNextJob(db, { now: at(12), leaseUntil: at(13), claimToken: 'tok-B' });
    expect(second?.id).toBe(first!.id);

    const error = await withTx(db, async (tx) => {
      await tx.service.create({ data: { workspaceId: a.workspaceId, code: 'STALE_WRITE', name: 'n', description: 'd', unitLabel: 'u' } });
      await fenceJob(tx, first!.id, 'tok-A', at(12.5));
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(LeaseLostError);
    expect((error as LeaseLostError).jobId).toBe(first!.id);
    expect(await db.service.count({ where: { code: 'STALE_WRITE' } })).toBe(0);
    const job = await db.job.findUniqueOrThrow({ where: { id: first!.id } });
    expect(job.claimToken).toBe('tok-B');
    expect(job.updatedAt.toISOString()).toBe(at(12).toISOString());
  });

  it('throws when the job is no longer RUNNING even with the right token', async () => {
    await createJob(db, 'fence-done', a.workspaceId);
    const claimed = await claimNextJob(db, { now: at(20), leaseUntil: at(21), claimToken: 'tok-done' });
    await db.job.update({ where: { id: claimed!.id }, data: { status: 'DEAD' } });
    await expect(fenceJob(db, claimed!.id, 'tok-done', at(20.5))).rejects.toBeInstanceOf(LeaseLostError);
  });
});
