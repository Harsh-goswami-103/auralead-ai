/**
 * Foundation-A (ADR-118 .. ADR-126): the lead-gen migration rebuilds WhatsAppTemplate (nullable
 * `syncedAt`, a composite foreign key to MediaAsset) and LeadExport (a NOT NULL `format`) while
 * Message rows reference WhatsAppTemplate under a Restrict foreign key. This test builds a database
 * at the previous migration with the real `prisma migrate deploy` (a config whose migrations
 * directory stops before the lead-gen migration), fills it with two workspaces of leads, templates,
 * template messages and exports, applies the lead-gen migration the way `npm run db:deploy` does,
 * and proves that nothing was lost: row counts, every Message.templateId, the copied values, the
 * new defaults (origin SYNCED, format csv), and foreign keys that are still enforced.
 */
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { createTestDb, migrateDeploy, type TestDb } from '../../support/db';
import { REPO_ROOT } from '../../support/spawn';
import { expectForeignKeyViolation, expectUniqueViolation } from './fixtures';

const MIGRATIONS_DIR = path.join(REPO_ROOT, 'prisma', 'migrations');
const TARGET_SUFFIX = '_lead_gen_suite';
const AT = '2026-10-15T10:00:00.000+00:00';
const SYNCED_AT = '2026-10-16T08:30:00.000+00:00';

let testDb: TestDb;
let target = '';
let previous: string[] = [];
let before: Snapshot;
let db: PrismaClient;

type Snapshot = {
  counts: Record<string, number>;
  messages: Array<{ id: string; workspaceId: string; templateId: string | null }>;
  templates: Array<{ id: string; workspaceId: string; integrationId: string; name: string; status: string; components: string; syncedAt: string }>;
};

const COUNTED = ['Workspace', 'WorkspaceSettings', 'Lead', 'Integration', 'WhatsAppTemplate', 'Conversation', 'Message', 'LeadExport'] as const;

async function snapshot(client: PrismaClient): Promise<Snapshot> {
  const counts: Record<string, number> = {};
  for (const table of COUNTED) {
    const rows = await client.$queryRawUnsafe<Array<{ n: bigint | number }>>(`SELECT COUNT(*) AS n FROM "${table}"`);
    counts[table] = Number(rows[0]?.n ?? -1);
  }
  const messages = await client.$queryRawUnsafe<Snapshot['messages']>(`SELECT "id", "workspaceId", "templateId" FROM "Message" ORDER BY "id"`);
  const templates = await client.$queryRawUnsafe<Snapshot['templates']>(
    `SELECT "id", "workspaceId", "integrationId", "name", "status", CAST("components" AS TEXT) AS "components", CAST("syncedAt" AS TEXT) AS "syncedAt" FROM "WhatsAppTemplate" ORDER BY "id"`,
  );
  return { counts, messages, templates };
}

/** Rows written with the columns that exist at the previous migration (the new client cannot write them there). */
async function fillPreviousSchema(client: PrismaClient): Promise<void> {
  const run = (sql: string, ...values: unknown[]) => client.$executeRawUnsafe(sql, ...values);
  for (const ws of ['a', 'b']) {
    await run(`INSERT INTO "Workspace" ("id", "slug", "name", "mode", "planLabel", "createdAt") VALUES (?, ?, ?, 'DEMO', 'Starter', ?)`, `ws_${ws}`, `ws-${ws}`, `Workspace ${ws}`, AT);
    await run(
      `INSERT INTO "WorkspaceSettings" ("workspaceId", "maxDiscountBps", "brandColor", "termsText", "updatedAt") VALUES (?, 1500, '#0f60fa', 'Terms', ?)`,
      `ws_${ws}`,
      AT,
    );
    await run(
      `INSERT INTO "Integration" ("id", "workspaceId", "kind", "status", "config") VALUES (?, ?, 'WHATSAPP_CLOUD', 'SIMULATED', '{"phoneNumberId":"1234567"}')`,
      `int_${ws}`,
      `ws_${ws}`,
    );
  }
  const leads: Array<[string, string, string]> = [
    ['lead_a1', 'ws_a', 'Sharma Dental Care'],
    ['lead_a2', 'ws_a', 'Kesari Sweets'],
    ['lead_b1', 'ws_b', 'Iron Temple Gym'],
  ];
  for (const [id, ws, name] of leads) {
    await run(
      `INSERT INTO "Lead" ("id", "workspaceId", "displayName", "nameNormalized", "phoneE164", "alternatePhones", "websiteStatus", "scoreReasons", "unknownInputs", "firstSource", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, '+919800000001', '[]', 'VERIFIED_ABSENT', '[]', '[]', 'GMAPS_EXTENSION', ?, ?)`,
      id,
      ws,
      name,
      name.toLowerCase(),
      AT,
      AT,
    );
  }
  const templates: Array<[string, string, string, string, string]> = [
    ['tpl_a1', 'ws_a', 'welcome_first_touch', 'MARKETING', 'APPROVED'],
    ['tpl_a2', 'ws_a', 'quote_ready_v1', 'UTILITY', 'APPROVED'],
    ['tpl_a3', 'ws_a', 'festive_offer_blast', 'MARKETING', 'REJECTED'],
    ['tpl_b1', 'ws_b', 'welcome_first_touch', 'MARKETING', 'APPROVED'],
  ];
  for (const [id, ws, name, category, status] of templates) {
    await run(
      `INSERT INTO "WhatsAppTemplate" ("id", "workspaceId", "integrationId", "name", "language", "category", "status", "components", "variableSchema", "intent", "variableMap", "categoryHistory", "syncedAt") VALUES (?, ?, ?, ?, 'en', ?, ?, ?, '[]', NULL, '{}', '[]', ?)`,
      id,
      ws,
      ws === 'ws_a' ? 'int_a' : 'int_b',
      name,
      category,
      status,
      JSON.stringify([{ type: 'BODY', text: `Hello {{1}} from ${name}` }]),
      SYNCED_AT,
    );
  }
  await run(`INSERT INTO "Conversation" ("id", "workspaceId", "leadId", "channel", "contactKey", "createdAt") VALUES ('conv_a1', 'ws_a', 'lead_a1', 'WHATSAPP', 'ck_a1', ?)`, AT);
  await run(`INSERT INTO "Conversation" ("id", "workspaceId", "leadId", "channel", "contactKey", "createdAt") VALUES ('conv_b1', 'ws_b', 'lead_b1', 'WHATSAPP', 'ck_b1', ?)`, AT);
  const messages: Array<[string, string, string, string, string, string | null]> = [
    ['msg_a1', 'ws_a', 'conv_a1', 'OUT', 'TEMPLATE', 'tpl_a1'],
    ['msg_a2', 'ws_a', 'conv_a1', 'IN', 'TEXT', null],
    ['msg_a3', 'ws_a', 'conv_a1', 'OUT', 'TEMPLATE', 'tpl_a2'],
    ['msg_a4', 'ws_a', 'conv_a1', 'OUT', 'TEMPLATE', 'tpl_a1'],
    ['msg_b1', 'ws_b', 'conv_b1', 'OUT', 'TEMPLATE', 'tpl_b1'],
  ];
  for (const [id, ws, conv, direction, kind, templateId] of messages) {
    await run(
      `INSERT INTO "Message" ("id", "workspaceId", "conversationId", "direction", "channel", "kind", "body", "templateId", "variables", "status", "createdAt") VALUES (?, ?, ?, ?, 'WHATSAPP', ?, ?, ?, ?, 'SENT', ?)`,
      id,
      ws,
      conv,
      direction,
      kind,
      kind === 'TEXT' ? 'What does a website cost?' : null,
      templateId,
      templateId ? JSON.stringify({ '1': 'Dr Sharma' }) : null,
      AT,
    );
  }
  await run(
    `INSERT INTO "LeadExport" ("id", "workspaceId", "requestKey", "status", "filters", "requestedBy", "correlationId", "rowCount", "path", "createdAt", "completedAt") VALUES ('exp_a1', 'ws_a', 'rk-1', 'READY', '{"sort":"newest"}', 'user_owner', 'corr-1', 2, 'exports/ws_a/exp_a1.csv', ?, ?)`,
    AT,
    AT,
  );
}

beforeAll(async () => {
  testDb = await createTestDb({ label: 'lead-gen-migration', migrate: false });
  const names = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  target = names.find((n) => n.endsWith(TARGET_SUFFIX)) ?? '';
  expect(target, 'the lead-gen migration exists').not.toBe('');
  previous = names.filter((n) => n < target);

  // A migrations directory that stops right before the lead-gen migration.
  const prevDir = path.join(testDb.dir, 'previous');
  await mkdir(path.join(prevDir, 'migrations'), { recursive: true });
  await cp(path.join(MIGRATIONS_DIR, 'migration_lock.toml'), path.join(prevDir, 'migrations', 'migration_lock.toml'));
  for (const name of previous) await cp(path.join(MIGRATIONS_DIR, name), path.join(prevDir, 'migrations', name), { recursive: true });
  const configPath = path.join(prevDir, 'prisma.config.mjs');
  const schemaPath = path.join(REPO_ROOT, 'prisma', 'schema.prisma').replace(/\\/g, '/');
  const migrationsPath = path.join(prevDir, 'migrations').replace(/\\/g, '/');
  await writeFile(
    configPath,
    `export default { schema: ${JSON.stringify(schemaPath)}, migrations: { path: ${JSON.stringify(migrationsPath)} }, datasource: { url: process.env.DATABASE_URL } };\n`,
  );

  await migrateDeploy(testDb.url, { configPath });
  const old = testDb.client();
  await fillPreviousSchema(old);
  before = await snapshot(old);
  await old.$disconnect();

  // The real deploy: the repository's config applies only the pending lead-gen migration.
  await migrateDeploy(testDb.url);
  db = testDb.client();
}, 180_000);

afterAll(async () => {
  await testDb?.destroy();
});

describe('the lead-gen migration on a populated database', () => {
  it('starts from the previous migration and applies only the lead-gen migration', async () => {
    expect(previous.length).toBeGreaterThan(0);
    expect(previous.at(-1)! < target).toBe(true);
    const applied = await db.$queryRawUnsafe<Array<{ migration_name: string; finished_at: unknown; rolled_back_at: unknown }>>(
      `SELECT "migration_name", "finished_at", "rolled_back_at" FROM "_prisma_migrations" ORDER BY "migration_name"`,
    );
    expect(applied.map((m) => m.migration_name)).toEqual([...previous, target]);
    for (const m of applied) {
      expect(m.finished_at, m.migration_name).not.toBeNull();
      expect(m.rolled_back_at, m.migration_name).toBeNull();
    }
  });

  it('keeps every row and every Message.templateId through the table rebuilds', async () => {
    expect(before.counts).toEqual({ Workspace: 2, WorkspaceSettings: 2, Lead: 3, Integration: 2, WhatsAppTemplate: 4, Conversation: 2, Message: 5, LeadExport: 1 });
    const after = await snapshot(db);
    expect(after.counts).toEqual(before.counts);
    expect(after.messages).toEqual(before.messages);
    expect(after.templates).toEqual(before.templates);
    expect(after.messages.filter((m) => m.templateId !== null)).toHaveLength(4);

    const viaClient = await db.message.findMany({ where: { templateId: { not: null } }, select: { id: true, template: { select: { id: true, name: true } } }, orderBy: { id: 'asc' } });
    expect(viaClient.map((m) => [m.id, m.template?.id])).toEqual([
      ['msg_a1', 'tpl_a1'],
      ['msg_a3', 'tpl_a2'],
      ['msg_a4', 'tpl_a1'],
      ['msg_b1', 'tpl_b1'],
    ]);
  });

  it('gives existing rows the new defaults and leaves the new optional columns empty', async () => {
    const templates = await db.whatsAppTemplate.findMany({ orderBy: { id: 'asc' } });
    expect(templates).toHaveLength(4);
    for (const t of templates) {
      expect(t.origin).toBe('SYNCED');
      expect(t.syncedAt?.toISOString()).toBe('2026-10-16T08:30:00.000Z');
      expect([t.providerTemplateId, t.rejectedReason, t.submittedBy, t.submittedAt, t.headerMediaId, t.copyGeneratorLabel, t.utilityTrigger]).toEqual([null, null, null, null, null, null, null]);
    }
    const exp = await db.leadExport.findUniqueOrThrow({ where: { id: 'exp_a1' } });
    expect(exp).toMatchObject({ format: 'csv', status: 'READY', rowCount: 2, path: 'exports/ws_a/exp_a1.csv', requestedBy: 'user_owner' });

    const leads = await db.lead.findMany({ orderBy: { id: 'asc' } });
    expect(leads.map((l) => [l.id, l.websiteStatus, l.firstSource])).toEqual([
      ['lead_a1', 'VERIFIED_ABSENT', 'GMAPS_EXTENSION'],
      ['lead_a2', 'VERIFIED_ABSENT', 'GMAPS_EXTENSION'],
      ['lead_b1', 'VERIFIED_ABSENT', 'GMAPS_EXTENSION'],
    ]);
    for (const l of leads) {
      expect([l.handedOverAt, l.pincode, l.placeId, l.placesContentExpiresAt, l.contactConfirmedAt, l.contactConfirmedVia]).toEqual([null, null, null, null, null, null]);
    }
    expect((await db.conversation.findMany()).map((c) => c.escalatedAt)).toEqual([null, null]);
    expect((await db.workspaceSettings.findMany()).map((s) => [s.whatsappOptInNotice, s.privacyContact])).toEqual([
      [null, null],
      [null, null],
    ]);
  });

  it('still enforces the foreign keys after the rebuild', async () => {
    expect(await db.$queryRawUnsafe(`PRAGMA foreign_key_check`)).toEqual([]);
    expect(await db.$queryRawUnsafe<Array<{ integrity_check: string }>>(`PRAGMA integrity_check`)).toEqual([{ integrity_check: 'ok' }]);
    // Restrict from Message still guards a template that was sent.
    await expectForeignKeyViolation(db.whatsAppTemplate.delete({ where: { id: 'tpl_a1' } }));
    // Composite keys: a message cannot name another workspace's template.
    await expectForeignKeyViolation(
      db.message.create({ data: { workspaceId: 'ws_a', conversationId: 'conv_a1', direction: 'OUT', channel: 'WHATSAPP', kind: 'TEMPLATE', templateId: 'tpl_b1', status: 'PENDING' } }),
    );
    // The new header foreign key refuses a media asset that does not exist in the workspace.
    await expectForeignKeyViolation(db.whatsAppTemplate.update({ where: { id: 'tpl_a3' }, data: { headerMediaId: 'media_missing' } }));
    // A template that nothing references can still be removed.
    await db.whatsAppTemplate.delete({ where: { id: 'tpl_a3' } });
  });

  it('accepts rows in the new tables with their keys', async () => {
    const createdAt = new Date('2026-10-23T09:00:00.000Z');
    const media = await db.mediaAsset.create({
      data: { workspaceId: 'ws_a', kind: 'DOCUMENT', fileName: 'brochure.pdf', mimeType: 'application/pdf', byteSize: 1024, sha256: 'a'.repeat(64), storagePath: 'media/ws_a/brochure.pdf', uploadedBy: 'user_owner', createdAt },
    });
    const authored = await db.whatsAppTemplate.create({
      data: {
        workspaceId: 'ws_a',
        integrationId: 'int_a',
        name: 'brochure_share',
        language: 'en',
        category: 'MARKETING',
        status: 'DRAFT',
        components: [],
        variableSchema: [],
        variableMap: {},
        categoryHistory: [],
        origin: 'AUTHORED',
        headerMediaId: media.id,
      },
    });
    expect(authored.syncedAt).toBeNull();
    await expectForeignKeyViolation(db.mediaAsset.delete({ where: { id: media.id } }));

    const run = await db.leadFinderRun.create({
      data: { workspaceId: 'ws_a', requestKey: 'rk-finder-1', requestedBy: 'user_owner', keywords: ['restaurants'], locations: ['Indore'], maxPerQuery: 20, emailBlacklist: [], createdAt },
    });
    expect(run).toMatchObject({ status: 'QUEUED', cellsTotal: 0, cellsDone: 0, resultsFound: 0, emailsFound: 0, extractEmails: false, simulated: false });
    const result = { workspaceId: 'ws_a', runId: run.id, placeId: 'ChIJ-demo-1', keyword: 'restaurants', location: 'Indore', hasPhone: true, websiteListed: false, emails: [], emailStatus: 'NOT_REQUESTED', createdAt };
    await db.leadFinderResult.create({ data: result });
    await expectUniqueViolation(db.leadFinderResult.create({ data: result }));
    await expectForeignKeyViolation(db.leadFinderResult.create({ data: { ...result, workspaceId: 'ws_b', placeId: 'ChIJ-demo-2' } }));
    await expectUniqueViolation(db.leadFinderRun.create({ data: { workspaceId: 'ws_a', requestKey: 'rk-finder-1', requestedBy: 'user_owner', keywords: [], locations: [], maxPerQuery: 20, emailBlacklist: [], createdAt } }));

    const handoff = await db.leadHandoff.create({ data: { workspaceId: 'ws_a', leadId: 'lead_a1', fromUserId: 'user_operator', summaryStatus: 'PENDING', createdAt } });
    expect(handoff.status).toBe('HANDED_OVER');
    await expectUniqueViolation(db.leadHandoff.create({ data: { workspaceId: 'ws_a', leadId: 'lead_a1', fromUserId: 'user_operator', summaryStatus: 'PENDING', createdAt } }));
    await expectForeignKeyViolation(db.leadHandoff.create({ data: { workspaceId: 'ws_b', leadId: 'lead_a2', fromUserId: 'user_operator', summaryStatus: 'PENDING', createdAt } }));

    const imp = await db.leadImport.create({
      data: { workspaceId: 'ws_a', requestKey: 'rk-import-1', requestedBy: 'user_owner', fileName: 'leads.xlsx', sheetName: 'Sheet1', sha256: 'b'.repeat(64), rowCount: 2, header: ['Name', 'Phone'], rejections: [], createdAt, expiresAt: new Date('2026-10-24T09:00:00.000Z') },
    });
    expect(imp).toMatchObject({ status: 'PREVIEW', consentAttested: false, accepted: 0, duplicates: 0, review: 0, rejected: 0, consentRecorded: 0, dataSource: null });
  });
});
