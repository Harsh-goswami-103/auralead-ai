/**
 * P20, ADR-126 (Foundation-B1): `demo:refresh` re-bases every time column the lead-gen suite added,
 * so seeded windows, expiries and "handed over 2 hours ago" stay true after a refresh.
 * - Static: every DateTime column of the new tables (LeadFinderRun, LeadFinderResult, LeadImport,
 *   LeadHandoff, MediaAsset) and the new time columns on Lead, WhatsAppTemplate and Conversation
 *   are listed in REBASE_COLUMNS, and every listed column is a DateTime column of its model.
 * - Behaviour: rows in those tables move by exactly the refresh shift; null times stay null; ids
 *   stay the same.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { seedId } from '../../../prisma/seed/ids';
import { REBASE_COLUMNS, REBASE_KEYS } from '../../../prisma/seed/rebase';
import { seedDemo } from '../../../prisma/seed/seed';
import { refreshDemo } from '../../../scripts/demo-refresh';
import { createTestDb, type TestDb } from '../../support/db';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const T0 = new Date('2026-10-15T04:30:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const NEW_TABLES = ['LeadFinderRun', 'LeadFinderResult', 'LeadImport', 'LeadHandoff', 'MediaAsset'] as const;
const NEW_COLUMNS: Record<string, string[]> = {
  Lead: ['handedOverAt', 'placesContentExpiresAt', 'contactConfirmedAt'],
  WhatsAppTemplate: ['syncedAt', 'submittedAt'],
  Conversation: ['escalatedAt'],
};

/** DateTime fields per model, parsed from prisma/schema.prisma. */
function dateTimeFields(): Map<string, Set<string>> {
  const source = readFileSync(path.join(REPO_ROOT, 'prisma', 'schema.prisma'), 'utf8');
  const out = new Map<string, Set<string>>();
  for (const match of source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const fields = new Set<string>();
    for (const raw of (match[2] ?? '').split('\n')) {
      const m = /^\s*(\w+)\s+DateTime\??(\s|$)/.exec(raw.replace(/\/\/.*$/, ''));
      if (m) fields.add(m[1]!);
    }
    out.set(match[1]!, fields);
  }
  return out;
}

describe('REBASE_COLUMNS (static)', () => {
  const models = dateTimeFields();

  it('lists every time column of the lead-gen tables and the new lead-gen columns', () => {
    for (const table of NEW_TABLES) {
      const fields = models.get(table);
      expect(fields?.size, table).toBeGreaterThan(0);
      expect([...(REBASE_COLUMNS[table] ?? [])].sort(), table).toEqual([...fields!].sort());
    }
    for (const [table, columns] of Object.entries(NEW_COLUMNS)) {
      for (const column of columns) expect(REBASE_COLUMNS[table] ?? [], `${table}.${column}`).toContain(column);
    }
  });

  it('names only DateTime columns of existing models', () => {
    for (const [table, columns] of Object.entries(REBASE_COLUMNS)) {
      const fields = models.get(table);
      expect(fields, table).toBeDefined();
      for (const column of columns) expect(fields!.has(column), `${table}.${column}`).toBe(true);
    }
    for (const table of Object.keys(REBASE_KEYS)) expect(REBASE_COLUMNS[table], table).toBeDefined();
  });
});

describe('demo:refresh re-bases the lead-gen time columns', () => {
  let testDb: TestDb;
  let db: PrismaClient;
  const WS = seedId('workspace', 'smile-avenue-dental');
  const OWNER = seedId('user', 'owner');
  const at = (hoursFromT0: number) => new Date(T0.getTime() + hoursFromT0 * HOUR);

  beforeAll(async () => {
    testDb = await createTestDb({ label: 'rebase-columns' });
    db = testDb.client();
    await seedDemo(db, { config: { mode: 'demo' }, now: T0 });
  }, 120_000);
  afterAll(async () => {
    await testDb?.destroy();
  });

  async function snapshot(table: string, ids: string[]): Promise<Map<string, Record<string, number | null>>> {
    const columns = REBASE_COLUMNS[table]!;
    const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT "id", ${columns.map((c) => `"${c}"`).join(', ')} FROM "${table}" WHERE "id" IN (${ids.map(() => '?').join(', ')})`,
      ...ids,
    );
    return new Map(
      rows.map((r) => [
        r.id as string,
        Object.fromEntries(columns.map((c) => [c, r[c] === null || r[c] === undefined ? null : new Date(r[c] as string | number | Date).getTime()])),
      ]),
    );
  }

  it('moves every set time by the shift, keeps nulls and ids', async () => {
    const lead = await db.lead.create({
      data: {
        workspaceId: WS,
        displayName: 'Rebase Places Lead',
        nameNormalized: 'rebase places lead',
        phoneE164: '+919826055555',
        alternatePhones: [],
        scoreReasons: [],
        unknownInputs: [],
        firstSource: 'GOOGLE_PLACES',
        placeId: 'ChIJ-rebase',
        createdAt: at(-48),
        updatedAt: at(-2),
        handedOverAt: at(-2),
        placesContentExpiresAt: at(30 * 24),
        contactConfirmedAt: at(-24),
      },
    });
    const conversation = await db.conversation.create({ data: { workspaceId: WS, leadId: lead.id, channel: 'WHATSAPP', contactKey: 'rebase-key', escalatedAt: at(-1), createdAt: at(-3) } });
    const integration = await db.integration.create({ data: { workspaceId: WS, kind: 'WHATSAPP_CLOUD', status: 'SIMULATED', config: {} } });
    const media = await db.mediaAsset.create({
      data: { workspaceId: WS, kind: 'DOCUMENT', fileName: 'brochure.pdf', mimeType: 'application/pdf', byteSize: 10, sha256: 'b'.repeat(64), storagePath: 'media/x.pdf', uploadedBy: OWNER, providerHandleAt: at(-5), createdAt: at(-6) },
    });
    const template = await db.whatsAppTemplate.create({
      data: {
        workspaceId: WS,
        integrationId: integration.id,
        name: 'brochure_offer',
        language: 'en',
        category: 'MARKETING',
        status: 'PENDING',
        components: [],
        variableSchema: [],
        variableMap: {},
        categoryHistory: [],
        origin: 'AUTHORED',
        syncedAt: null,
        submittedAt: at(-0.5),
        headerMediaId: media.id,
      },
    });
    const run = await db.leadFinderRun.create({
      data: { workspaceId: WS, requestKey: 'rebase-run', requestedBy: OWNER, keywords: ['web design'], locations: ['Indore'], maxPerQuery: 20, emailBlacklist: [], status: 'SUCCEEDED', createdAt: at(-4), startedAt: at(-4), finishedAt: at(-3.9), cancelledAt: null },
    });
    const result = await db.leadFinderResult.create({
      data: {
        workspaceId: WS,
        runId: run.id,
        placeId: 'ChIJ-rebase',
        keyword: 'web design',
        location: 'Indore',
        name: 'Rebase Places Lead',
        hasPhone: true,
        websiteListed: false,
        emails: [],
        emailStatus: 'NOT_REQUESTED',
        contentExpiresAt: at(20),
        contentPurgedAt: null,
        importedLeadId: lead.id,
        importedAt: at(-3),
        createdAt: at(-4),
      },
    });
    const leadImport = await db.leadImport.create({
      data: {
        workspaceId: WS,
        requestKey: 'rebase-import',
        requestedBy: OWNER,
        fileName: 'leads.xlsx',
        sheetName: 'Sheet1',
        sha256: 'c'.repeat(64),
        rowCount: 2,
        header: ['Name', 'Phone'],
        rejections: [],
        status: 'SUCCEEDED',
        consentAttested: true,
        consentAttestedBy: OWNER,
        consentAttestedAt: at(-7),
        createdAt: at(-8),
        expiresAt: at(16),
        finishedAt: at(-7),
      },
    });
    const handoff = await db.leadHandoff.create({ data: { workspaceId: WS, leadId: lead.id, fromUserId: OWNER, summaryStatus: 'READY', status: 'HANDED_OVER', acknowledgedAt: null, createdAt: at(-2) } });

    const ids: Record<string, string[]> = {
      Lead: [lead.id],
      Conversation: [conversation.id],
      WhatsAppTemplate: [template.id],
      MediaAsset: [media.id],
      LeadFinderRun: [run.id],
      LeadFinderResult: [result.id],
      LeadImport: [leadImport.id],
      LeadHandoff: [handoff.id],
    };
    const before = new Map(await Promise.all(Object.entries(ids).map(async ([t, list]) => [t, await snapshot(t, list)] as const)));

    const T1 = new Date(T0.getTime() + 2 * DAY + 5 * HOUR);
    const shift = T1.getTime() - T0.getTime();
    await refreshDemo(db, { config: { mode: 'demo' }, now: T1 });

    for (const [table, list] of Object.entries(ids)) {
      const after = await snapshot(table, list);
      expect([...after.keys()].sort(), table).toEqual([...list].sort());
      for (const id of list) {
        const was = before.get(table)!.get(id)!;
        const now = after.get(id)!;
        for (const column of REBASE_COLUMNS[table]!) {
          const expected = was[column] === null ? null : was[column]! + shift;
          expect(now[column], `${table}.${column}`).toBe(expected);
        }
      }
    }
    // Spot checks on the columns the refresh exists for.
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).handedOverAt?.toISOString()).toBe(new Date(at(-2).getTime() + shift).toISOString());
    expect((await db.whatsAppTemplate.findUniqueOrThrow({ where: { id: template.id } })).syncedAt).toBeNull();
    expect((await db.leadFinderRun.findUniqueOrThrow({ where: { id: run.id } })).cancelledAt).toBeNull();
  });
});
