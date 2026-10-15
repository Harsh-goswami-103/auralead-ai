/**
 * E3 / ADR-37: Suppression is append-only history. At most one active (clearedAt IS NULL) row per
 * (workspaceId, channel, contactKey); a cleared row plus a new active row is allowed, so Stop,
 * START, Stop leaves two rows with exactly one active.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { createTestDb, type TestDb } from '../../support/db';
import { at, createTenantGraph, expectUniqueViolation, type TenantGraph } from './fixtures';

let testDb: TestDb;
let db: PrismaClient;
let a: TenantGraph;

beforeAll(async () => {
  testDb = await createTestDb({ label: 'suppression-history' });
  db = testDb.client();
  a = await createTenantGraph(db, 'alpha');
});

afterAll(async () => {
  await testDb?.destroy();
});

describe('Suppression history', () => {
  const key = { channel: 'WHATSAPP' as const, contactKey: 'hmac-history-1' };

  it('rejects two active rows for one contact and channel', async () => {
    await db.suppression.create({ data: { workspaceId: a.workspaceId, ...key, reason: 'STOP_BUTTON', createdAt: at(1) } });
    await expectUniqueViolation(db.suppression.create({ data: { workspaceId: a.workspaceId, ...key, reason: 'STOP_KEYWORD', createdAt: at(2) } }));
    expect(await db.suppression.count({ where: { workspaceId: a.workspaceId, ...key } })).toBe(1);
  });

  it('allows a cleared row plus a new active row, and never more than one active', async () => {
    const consent = await db.consentRecord.create({
      data: {
        workspaceId: a.workspaceId,
        leadId: a.leadId,
        contactKey: key.contactKey,
        channel: 'WHATSAPP',
        purpose: 'MARKETING',
        basis: 'OPT_IN',
        source: 'START_KEYWORD',
        evidence: { messageId: 'wamid.start' },
        collectedAt: at(3),
        recordedAt: at(3),
      },
    });
    // START: the active row is cleared by the newer consent.
    const cleared = await db.suppression.updateMany({
      where: { workspaceId: a.workspaceId, ...key, clearedAt: null },
      data: { clearedAt: at(3), clearedByConsentId: consent.id },
    });
    expect(cleared.count).toBe(1);

    // Second Stop after the clear inserts a new active row.
    await db.suppression.create({ data: { workspaceId: a.workspaceId, ...key, reason: 'STOP_KEYWORD', createdAt: at(4) } });
    // A third concurrent Stop is still rejected.
    await expectUniqueViolation(db.suppression.create({ data: { workspaceId: a.workspaceId, ...key, reason: 'STOP_BUTTON', createdAt: at(5) } }));

    const rows = await db.suppression.findMany({ where: { workspaceId: a.workspaceId, ...key }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => [r.reason, r.clearedAt?.toISOString() ?? null, r.clearedByConsentId])).toEqual([
      ['STOP_BUTTON', at(3).toISOString(), consent.id],
      ['STOP_KEYWORD', null, null],
    ]);
  });

  it('cannot clear into a state with two active rows by un-clearing history', async () => {
    await expectUniqueViolation(
      db.suppression.updateMany({ where: { workspaceId: a.workspaceId, ...key, reason: 'STOP_BUTTON' }, data: { clearedAt: null } }),
    );
  });

  it('survives deletion of the lead it was raised for (keyed on contact, not lead)', async () => {
    const lead = await db.lead.create({
      data: { workspaceId: a.workspaceId, displayName: 'Erase me', nameNormalized: 'erase me', alternatePhones: [], scoreReasons: [], unknownInputs: [], firstSource: 'MANUAL' },
    });
    await db.suppression.create({ data: { workspaceId: a.workspaceId, channel: 'EMAIL', contactKey: 'hmac-erase', contactPlain: 'x@y.test', reason: 'UNSUBSCRIBE' } });
    await db.lead.delete({ where: { id: lead.id } });
    const row = await db.suppression.findFirstOrThrow({ where: { contactKey: 'hmac-erase' } });
    expect(row.clearedAt).toBeNull();
  });
});
