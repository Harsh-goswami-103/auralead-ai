/**
 * T03: every UNIQUE and PARTIAL UNIQUE that guards an invariant rejects a duplicate on the real
 * migrated SQLite file, and accepts the row that the partial predicate lets through.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { createTestDb, type TestDb } from '../../support/db';
import { T0, at, createJob, createTenantGraph, expectUniqueViolation, type TenantGraph } from './fixtures';

let testDb: TestDb;
let db: PrismaClient;
let a: TenantGraph;
let b: TenantGraph;

beforeAll(async () => {
  testDb = await createTestDb({ label: 'schema-constraints' });
  db = testDb.client();
  a = await createTenantGraph(db, 'alpha');
  b = await createTenantGraph(db, 'beta');
});

afterAll(async () => {
  await testDb?.destroy();
});

describe('migration', () => {
  it('creates every partial unique index declared in the schema', async () => {
    const rows = await db.$queryRawUnsafe<Array<{ name: string; sql: string }>>(
      `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql LIKE '%WHERE%' ORDER BY name`,
    );
    expect(rows.map((r) => r.name)).toEqual([
      'Approval_one_approved_per_quote_version',
      'Approval_one_open_per_message',
      'Conversation_one_open_per_lead_channel',
      'PipelineConfigVersion_one_active',
      'PricingVersion_one_active',
      'ScoringConfigVersion_one_active',
      'Suppression_active_contact_key',
      'WebhookRejection_unrouted_day',
    ]);
  });
});

describe('LeadContactKey (workspaceId, kind, value)', () => {
  it('rejects a second lead claiming the same contact key in one workspace', async () => {
    await db.leadContactKey.create({ data: { workspaceId: a.workspaceId, leadId: a.leadId, kind: 'PHONE', value: '+919811111111' } });
    const other = await db.lead.create({
      data: {
        workspaceId: a.workspaceId,
        displayName: 'Other',
        nameNormalized: 'other',
        alternatePhones: [],
        scoreReasons: [],
        unknownInputs: [],
        firstSource: 'MANUAL',
      },
    });
    await expectUniqueViolation(
      db.leadContactKey.create({ data: { workspaceId: a.workspaceId, leadId: other.id, kind: 'PHONE', value: '+919811111111' } }),
    );
  });

  it('allows the same contact key in another workspace and under another kind', async () => {
    await db.leadContactKey.create({ data: { workspaceId: b.workspaceId, leadId: b.leadId, kind: 'PHONE', value: '+919811111111' } });
    await db.leadContactKey.create({ data: { workspaceId: a.workspaceId, leadId: a.leadId, kind: 'PROVIDER', value: '+919811111111' } });
    expect(await db.leadContactKey.count({ where: { value: '+919811111111' } })).toBe(3);
  });
});

describe('Suppression active row', () => {
  it('rejects a second active row for the same contact and channel', async () => {
    const data = { workspaceId: a.workspaceId, channel: 'WHATSAPP' as const, contactKey: 'hmac-sc-1', reason: 'STOP_BUTTON' as const };
    await db.suppression.create({ data: { ...data, createdAt: at(1) } });
    await expectUniqueViolation(db.suppression.create({ data: { ...data, reason: 'STOP_KEYWORD', createdAt: at(2) } }));
  });

  it('keys active rows per channel and per workspace', async () => {
    await db.suppression.create({ data: { workspaceId: a.workspaceId, channel: 'EMAIL', contactKey: 'hmac-sc-1', reason: 'UNSUBSCRIBE' } });
    await db.suppression.create({ data: { workspaceId: b.workspaceId, channel: 'WHATSAPP', contactKey: 'hmac-sc-1', reason: 'STOP_BUTTON' } });
    expect(await db.suppression.count({ where: { contactKey: 'hmac-sc-1', clearedAt: null } })).toBe(3);
  });
});

describe('Approval', () => {
  it('allows only one APPROVED quote-version approval per version', async () => {
    const base = { workspaceId: a.workspaceId, kind: 'QUOTE_VERSION' as const, quoteId: a.quoteId, quoteVersionId: a.quoteVersionId, flags: {}, requestedAt: T0 };
    await db.approval.create({ data: { ...base, status: 'APPROVED', decidedAt: at(1) } });
    await expectUniqueViolation(db.approval.create({ data: { ...base, status: 'APPROVED', decidedAt: at(2) } }));
    // Rejected and invalidated history rows for the same version are fine.
    await db.approval.create({ data: { ...base, status: 'REJECTED' } });
    await db.approval.create({ data: { ...base, status: 'INVALIDATED' } });
    expect(await db.approval.count({ where: { quoteVersionId: a.quoteVersionId } })).toBe(3);
  });

  it('allows only one PENDING or APPROVED approval per message', async () => {
    const base = { workspaceId: a.workspaceId, kind: 'OUTBOUND_MESSAGE' as const, messageId: a.messageId, flags: {}, requestedAt: T0 };
    await db.approval.create({ data: { ...base, status: 'PENDING' } });
    await expectUniqueViolation(db.approval.create({ data: { ...base, status: 'PENDING' } }));
    await expectUniqueViolation(db.approval.create({ data: { ...base, status: 'APPROVED' } }));
    await db.approval.create({ data: { ...base, status: 'REJECTED' } });
    expect(await db.approval.count({ where: { messageId: a.messageId } })).toBe(2);
  });
});

describe('one active version per workspace', () => {
  it('rejects a second active PricingVersion, allows inactive ones and other workspaces', async () => {
    await expectUniqueViolation(
      db.pricingVersion.create({ data: { workspaceId: a.workspaceId, version: 2, active: true, note: 'v2', createdBy: 't' } }),
    );
    await db.pricingVersion.create({ data: { workspaceId: a.workspaceId, version: 2, active: false, note: 'v2', createdBy: 't' } });
    expect(await db.pricingVersion.count({ where: { active: true } })).toBe(2);
  });

  it('rejects a second active ScoringConfigVersion and PipelineConfigVersion', async () => {
    await db.scoringConfigVersion.create({ data: { workspaceId: a.workspaceId, version: 1, weights: {}, active: true, createdBy: 't' } });
    await expectUniqueViolation(
      db.scoringConfigVersion.create({ data: { workspaceId: a.workspaceId, version: 2, weights: {}, active: true, createdBy: 't' } }),
    );
    await db.pipelineConfigVersion.create({ data: { workspaceId: a.workspaceId, version: 1, graph: {}, active: true, createdBy: 't' } });
    await expectUniqueViolation(
      db.pipelineConfigVersion.create({ data: { workspaceId: a.workspaceId, version: 2, graph: {}, active: true, createdBy: 't' } }),
    );
  });
});

describe('DispatchAttempt', () => {
  it('rejects a duplicate idempotencyKey and a duplicate (messageId, attemptNo)', async () => {
    const job1 = await createJob(db, 'dispatch-1', a.workspaceId);
    const job2 = await createJob(db, 'dispatch-2', a.workspaceId);
    const base = {
      workspaceId: a.workspaceId,
      messageId: a.messageId,
      channel: 'WHATSAPP' as const,
      sendIntent: 'MANUAL_SINGLE' as const,
      initiatedBy: 'user_1',
    };
    await db.dispatchAttempt.create({ data: { ...base, attemptNo: 1, idempotencyKey: 'disp:a:1', jobId: job1.id } });
    await expectUniqueViolation(db.dispatchAttempt.create({ data: { ...base, attemptNo: 2, idempotencyKey: 'disp:a:1', jobId: job2.id } }));
    await expectUniqueViolation(db.dispatchAttempt.create({ data: { ...base, attemptNo: 1, idempotencyKey: 'disp:a:2', jobId: job2.id } }));
  });
});

describe('WebhookEvent (provider, scopeKey, externalKey)', () => {
  const base = { provider: 'GOOGLE_SHEETS' as const, externalKey: 'evt-1', bodySha256: 'x', payloadRedacted: {}, receivedAt: T0 };

  it('dedupes a replay within one scope', async () => {
    await db.webhookEvent.create({ data: { ...base, scopeKey: a.integrationId, workspaceId: a.workspaceId } });
    await expectUniqueViolation(db.webhookEvent.create({ data: { ...base, scopeKey: a.integrationId, workspaceId: a.workspaceId } }));
  });

  it('accepts the same external key from another scope (E2)', async () => {
    await db.webhookEvent.create({ data: { ...base, scopeKey: b.integrationId, workspaceId: b.workspaceId } });
    await db.webhookEvent.create({ data: { ...base, scopeKey: 'unrouted' } });
    expect(await db.webhookEvent.count({ where: { externalKey: 'evt-1' } })).toBe(3);
  });
});

describe('QuoteAcceptance', () => {
  it('accepts a quote version at most once', async () => {
    const data = { workspaceId: a.workspaceId, quoteId: a.quoteId, quoteVersionId: a.quoteVersionId, acceptorName: 'R', ipHash: 'h', userAgent: 'ua', acceptedAt: at(5) };
    await db.quoteAcceptance.create({ data });
    await expectUniqueViolation(db.quoteAcceptance.create({ data: { ...data, acceptedAt: at(6) } }));
  });
});

describe('PipelineStageRun (executionId, stage)', () => {
  it('runs a stage at most once per execution (E9)', async () => {
    const pcv = await db.pipelineConfigVersion.create({ data: { workspaceId: b.workspaceId, version: 1, graph: {}, active: true, createdBy: 't' } });
    const execution = await db.pipelineExecution.create({
      data: { workspaceId: b.workspaceId, leadId: b.leadId, pipelineConfigVersionId: pcv.id },
    });
    await db.pipelineStageRun.create({ data: { workspaceId: b.workspaceId, executionId: execution.id, stage: 'SCORE' } });
    await expectUniqueViolation(db.pipelineStageRun.create({ data: { workspaceId: b.workspaceId, executionId: execution.id, stage: 'SCORE' } }));
    await db.pipelineStageRun.create({ data: { workspaceId: b.workspaceId, executionId: execution.id, stage: 'DRAFT' } });
    // One execution per lead.
    await expectUniqueViolation(
      db.pipelineExecution.create({ data: { workspaceId: b.workspaceId, leadId: b.leadId, pipelineConfigVersionId: pcv.id } }),
    );
  });
});

describe('Conversation open per lead and channel', () => {
  it('rejects a second open conversation, allows one after the first is closed', async () => {
    const data = { workspaceId: a.workspaceId, leadId: a.leadId, channel: 'WHATSAPP' as const, contactKey: 'ck-alpha' };
    await expectUniqueViolation(db.conversation.create({ data }));
    await db.conversation.update({ where: { id: a.conversationId }, data: { closedAt: at(10) } });
    const reopened = await db.conversation.create({ data });
    expect(reopened.closedAt).toBeNull();
  });
});

describe('WebhookRejection counters', () => {
  it('keeps one counter row per (provider, workspace, reason, day), including unrouted rejections', async () => {
    const day = new Date('2026-10-15T00:00:00.000Z');
    await db.webhookRejection.create({ data: { provider: 'META_ADS', workspaceId: a.workspaceId, reason: 'BAD_SIGNATURE', day, count: 1 } });
    await expectUniqueViolation(
      db.webhookRejection.create({ data: { provider: 'META_ADS', workspaceId: a.workspaceId, reason: 'BAD_SIGNATURE', day, count: 1 } }),
    );
    await db.webhookRejection.create({ data: { provider: 'META_ADS', workspaceId: null, reason: 'BAD_SIGNATURE', day, count: 1 } });
    await expectUniqueViolation(
      db.webhookRejection.create({ data: { provider: 'META_ADS', workspaceId: null, reason: 'BAD_SIGNATURE', day, count: 1 } }),
    );
  });
});

describe('money columns', () => {
  it('stores paise beyond the 32-bit range exactly (ADR-07)', async () => {
    const big = 10_000_000_000_00n; // Rs 100 crore in paise
    const entry = await db.priceEntry.findFirstOrThrow({ where: { workspaceId: a.workspaceId } });
    await db.priceEntry.update({ where: { id: entry.id }, data: { unitPricePaise: big } });
    const reread = await db.priceEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(reread.unitPricePaise).toBe(big);
  });
});
