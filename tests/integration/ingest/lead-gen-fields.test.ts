// ADR-118, ADR-119, ADR-120 (Foundation-B1): the ingest contract carries `pincode`,
// `websiteListed` and `placeId`.
// - A GOOGLE_PLACES record keeps its place ID on the lead (`Lead.placeId`), dedupes by the provider
//   key `GOOGLE_PLACES:<placeId>` (from `providerId` or `fields.placeId`), and marks the
//   Places-sourced fields with `placesContentExpiresAt` = ingestion time + 30 days (injected clock).
// - `NOT_LISTED` is set only when the record says `websiteListed: false` and carries no website.
// - Other sources never get a place ID or a Places expiry; every source keeps a valid PIN code.
// - A duplicate never modifies the existing lead; a place ID that contradicts `providerId` is a
//   validation error for the whole batch and nothing is written.
// - End to end in DEMO: a NOT_LISTED lead goes through the SCORE stage without any fetch and, with
//   `websitePreference 'ABSENT'`, earns the full website points labelled "No website listed".
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { createLogger } from '@/lib/logger';
import { toAppError, ValidationError } from '@/lib/errors';
import { createPipelineAdvanceJob } from '@/server/jobs/handlers/pipeline-advance';
import { buildJobRegistry } from '@/server/jobs/registry';
import { ingestBatch, PLACES_CONTENT_TTL_MS } from '@/server/services/leads/ingest';
import { StageRegistry } from '@/server/services/pipeline/stages';
import { ingestionStage } from '@/server/services/pipeline/stages/ingestion';
import { createScoreStage } from '@/server/services/pipeline/stages/score';
import { seedId } from '../../../prisma/seed/ids';
import { SCORING_V1 } from '../../../prisma/seed/fixtures/configs';
import { createWorker } from '../../../worker/worker';
import { createIngestHarness, ctxFor, DEPS, WS_B, type IngestHarness } from './support';

let h: IngestHarness;
let db: PrismaClient;

beforeAll(async () => {
  h = await createIngestHarness('lead-gen-fields');
  db = h.db;
});
afterAll(async () => {
  await h.testDb.destroy();
});

const DAY = 86_400_000;

async function keysOf(leadId: string) {
  const rows = await db.leadContactKey.findMany({ where: { leadId } });
  return rows.map((k) => `${k.kind} ${k.value}`).sort();
}

describe('ingest: Places and import fields', () => {
  it('a Places record keeps its place ID, PIN code and NOT_LISTED, with a 30-day Places expiry', async () => {
    expect(PLACES_CONTENT_TTL_MS).toBe(30 * DAY);
    const result = await ingestBatch(
      ctxFor(db, h.clock),
      {
        source: 'GOOGLE_PLACES',
        externalBatchId: 'finder:run-1:a',
        simulated: true,
        records: [
          {
            externalId: 'finder:ChIJ-annapurna',
            providerId: 'ChIJ-annapurna',
            fields: { name: 'Annapurna Sweets', phone: '98260 10001', address: '12 MG Road, Indore', city: 'Indore', pincode: '452 001', category: 'Sweet shop', rating: 4.4, reviewCount: 310, websiteListed: false, placeId: 'ChIJ-annapurna' },
            attribution: { keyword: 'sweet shop', location: 'Indore' },
          },
        ],
      },
      DEPS,
    );
    expect(result.records[0]).toMatchObject({ status: 'ACCEPTED', consent: { outcome: 'NONE' } });
    const lead = await db.lead.findUniqueOrThrow({ where: { id: result.records[0]!.leadId! } });
    expect(lead).toMatchObject({
      firstSource: 'GOOGLE_PLACES',
      placeId: 'ChIJ-annapurna',
      pincode: '452001',
      website: null,
      websiteStatus: 'NOT_LISTED',
      city: 'Indore',
      rating: 44,
      reviewCount: 310,
      contactConfirmedAt: null,
      contactConfirmedVia: null,
      handedOverAt: null,
    });
    expect(lead.placesContentExpiresAt?.toISOString()).toBe(new Date(h.clock.now().getTime() + 30 * DAY).toISOString());
    expect(await keysOf(lead.id)).toEqual(['PHONE +919826010001', 'PROVIDER GOOGLE_PLACES:ChIJ-annapurna'].sort());
  });

  it('takes the place ID from fields.placeId or providerId, and a listed website stays PRESENT_UNVERIFIED', async () => {
    const result = await ingestBatch(
      ctxFor(db, h.clock),
      {
        source: 'GOOGLE_PLACES',
        externalBatchId: 'finder:run-1:b',
        records: [
          { externalId: 'finder:ChIJ-fields-only', fields: { name: 'Malwa Printers', phone: '98260 10002', placeId: 'ChIJ-fields-only', websiteListed: true, website: 'malwaprinters.in' } },
          { externalId: 'finder:ChIJ-provider-only', providerId: 'ChIJ-provider-only', fields: { name: 'Rajwada Optics', phone: '98260 10003' } },
        ],
      },
      DEPS,
    );
    const [fieldsOnly, providerOnly] = await Promise.all(result.records.map((r) => db.lead.findUniqueOrThrow({ where: { id: r.leadId! } })));
    expect(fieldsOnly).toMatchObject({ placeId: 'ChIJ-fields-only', website: 'https://malwaprinters.in/', websiteStatus: 'PRESENT_UNVERIFIED' });
    expect(await keysOf(fieldsOnly!.id)).toContain('PROVIDER GOOGLE_PLACES:ChIJ-fields-only');
    // No statement about the website: UNKNOWN, as before ADR-119.
    expect(providerOnly).toMatchObject({ placeId: 'ChIJ-provider-only', websiteStatus: 'UNKNOWN' });
    expect(providerOnly!.placesContentExpiresAt).not.toBeNull();

    // The same place found again (another run) is a duplicate by its provider key.
    const again = await ingestBatch(
      ctxFor(db, h.clock),
      { source: 'GOOGLE_PLACES', externalBatchId: 'finder:run-2:a', records: [{ externalId: 'finder:run-2:ChIJ-fields-only', fields: { name: 'Malwa Printers', email: 'hello@malwaprinters.in', placeId: 'ChIJ-fields-only' } }] },
      DEPS,
    );
    expect(again.records[0]).toMatchObject({ status: 'DUPLICATE', reasonCode: 'CONTACT_MATCH', leadId: fieldsOnly!.id });
  });

  it('other sources keep the PIN code but never a place ID or a Places expiry', async () => {
    const result = await ingestBatch(
      ctxFor(db, h.clock),
      {
        source: 'FILE_IMPORT',
        externalBatchId: 'import:1:0',
        records: [{ externalId: 'import:1:row-2', fields: { name: 'Sarafa Jewellers', phone: '98260 10004', pincode: 452002, placeId: 'ChIJ-from-a-file', websiteListed: false } }],
      },
      DEPS,
    );
    const lead = await db.lead.findUniqueOrThrow({ where: { id: result.records[0]!.leadId! } });
    expect(lead).toMatchObject({ firstSource: 'FILE_IMPORT', pincode: '452002', placeId: null, placesContentExpiresAt: null, websiteStatus: 'NOT_LISTED' });
    expect((await keysOf(lead.id)).some((k) => k.startsWith('PROVIDER'))).toBe(false);
  });

  it('a duplicate does not modify the existing lead', async () => {
    const first = await ingestBatch(
      ctxFor(db, h.clock),
      { source: 'GMAPS_EXTENSION', externalBatchId: 'ext-dup-1', records: [{ externalId: 'ext-1', providerId: 'ChIJ-ext-1', fields: { name: 'Palasia Dental', phone: '98260 10005' } }] },
      DEPS,
    );
    const leadId = first.records[0]!.leadId!;
    const before = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(before).toMatchObject({ placeId: null, placesContentExpiresAt: null, pincode: null, websiteStatus: 'UNKNOWN' });

    const dup = await ingestBatch(
      ctxFor(db, h.clock),
      {
        source: 'GOOGLE_PLACES',
        externalBatchId: 'finder:run-3:a',
        records: [{ externalId: 'finder:ChIJ-ext-1', providerId: 'ChIJ-ext-1', fields: { name: 'Palasia Dental', phone: '98260 10005', pincode: '452001', websiteListed: false } }],
      },
      DEPS,
    );
    expect(dup.records[0]).toMatchObject({ status: 'DUPLICATE', leadId });
    expect(await db.lead.findUniqueOrThrow({ where: { id: leadId } })).toEqual(before);
  });

  it('a place ID that contradicts providerId refuses the whole batch and writes nothing', async () => {
    const input = {
      source: 'GOOGLE_PLACES' as const,
      externalBatchId: 'finder:run-4:a',
      records: [
        { externalId: 'finder:ok', providerId: 'ChIJ-ok', fields: { name: 'Vijay Nagar Cafe', phone: '98260 10006' } },
        { externalId: 'finder:bad', providerId: 'ChIJ-one', fields: { name: 'Bhawarkua Books', phone: '98260 10007', placeId: 'ChIJ-two' } },
      ],
    };
    const error = await ingestBatch(ctxFor(db, h.clock), input, DEPS).catch((e: unknown) => e);
    const mapped = toAppError(error);
    expect(mapped).toBeInstanceOf(ValidationError);
    expect(mapped.status).toBe(400);
    expect(mapped.safeDetails).toEqual({ issues: [expect.objectContaining({ path: 'records.1.fields.placeId' })] });
    expect(await db.importBatch.count({ where: { externalBatchId: 'finder:run-4:a' } })).toBe(0);
    expect(await db.lead.count({ where: { displayName: 'Vijay Nagar Cafe' } })).toBe(0);
  });

  it('end to end in DEMO: NOT_LISTED is scored without a fetch and earns the website points when ABSENT is preferred', async () => {
    // Workspace B prefers leads without a website (a web-development client, ADR-126).
    const v1 = seedId('scoring-version', 'ironpulse-fitness:1');
    await db.$transaction([
      db.scoringConfigVersion.update({ where: { id: v1 }, data: { active: false } }),
      db.scoringConfigVersion.create({ data: { id: 'scv_absent_b', workspaceId: WS_B, version: 2, active: true, createdBy: 'test', weights: { ...SCORING_V1, websitePreference: 'ABSENT' } } }),
    ]);
    const fetches: string[] = [];
    const stages = new StageRegistry()
      .register(ingestionStage)
      .register(
        createScoreStage({
          fetchWebsite: async (url) => {
            fetches.push(url);
            throw new Error('no fetch expected');
          },
        }),
      );
    const worker = createWorker(
      { db, clock: h.clock, registry: buildJobRegistry([createPipelineAdvanceJob({ stages, mode: () => 'demo' })]), logger: createLogger({ level: 'silent' }), mode: 'demo', version: 'test', random: () => 0 },
      { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
    );

    const result = await ingestBatch(
      ctxFor(db, h.clock, WS_B),
      {
        source: 'GOOGLE_PLACES',
        externalBatchId: 'finder:run-5:a',
        simulated: true,
        records: [{ externalId: 'finder:ChIJ-gym', providerId: 'ChIJ-gym', fields: { name: 'Lalbagh Fitness', phone: '98260 10008', websiteListed: false } }],
      },
      DEPS,
    );
    const leadId = result.records[0]!.leadId!;
    while ((await worker.tick()) === 'ran');

    expect(fetches).toEqual([]);
    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.websiteStatus).toBe('NOT_LISTED');
    expect(lead.scoreConfigVersionId).toBe('scv_absent_b');
    expect(lead.scoreReasons).toEqual(expect.arrayContaining([{ input: 'websiteStatus', points: 20, maxPoints: 20, label: 'No website listed' }]));
    expect((lead.unknownInputs as Array<{ input: string }>).map((u) => u.input)).not.toContain('websiteStatus');
    const execution = await db.pipelineExecution.findUniqueOrThrow({ where: { leadId } });
    const score = await db.pipelineStageRun.findFirstOrThrow({ where: { executionId: execution.id, stage: 'SCORE' } });
    expect(score).toMatchObject({ status: 'DONE' });
    expect(score.outputRef).toMatchObject({ website: { checked: false, status: 'NOT_LISTED', reasonCode: 'NOT_LISTED' } });
  });
});
