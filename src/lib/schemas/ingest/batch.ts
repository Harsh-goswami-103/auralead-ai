/**
 * Ingestion input contract (R12, P1), shared by every source: the demo simulators (T11), the
 * Sheets Apps Script webhook and preview sync (T34), the Meta lead fetch (T35) and the Maps
 * extension bridge (T36) all map their payloads onto `IngestBatchInput` and call
 * `ingestBatch(ctx, input, deps)`.
 *
 * - `externalBatchId` is the source's batch identity (extension batchId, sheet sync run id or
 *   event id, `meta:{page}:{leadgen}`); with the workspace and source it makes the batch
 *   idempotent.
 * - `externalId` is the per-record identity (leadgen_id, sheet row or event id, extension
 *   sourceRef); with the workspace and source it makes the record idempotent.
 * - `providerId` is a stable provider key for the business itself (Maps place id), stored as a
 *   PROVIDER contact key `<source>:<providerId>` for dedupe. A GOOGLE_PLACES record may give its
 *   place ID as `fields.placeId` instead (ADR-118); a record that gives both must give the same.
 * - `fields.pincode`, `fields.websiteListed` and `fields.placeId` (lead-gen suite): see
 *   `normalizeLeadFields` and `ingestBatch` for what each sets on the lead.
 * - `answers` are the raw form answers keyed by column or question key. They are read only for
 *   the consent mapping and are stored redacted.
 * - `mapping.consent` (P1, ADR-15) defines the consent field. `noticeTextHash`, when given, must
 *   equal sha256(noticeText); the service computes it either way.
 */
import { z } from 'zod';
import { Channel, ConsentPurpose, LeadSource } from '../../domain/enums';

const text = (max: number) => z.string().max(max).nullish();
const isoTime = z.iso.datetime({ offset: true });

export const ingestFieldsSchema = z.object({
  name: text(300),
  phone: text(300),
  email: text(320),
  website: text(2048),
  address: text(1000),
  city: text(200),
  category: text(200),
  rating: z.union([z.number(), z.string().max(20)]).nullish(),
  reviewCount: z.union([z.number(), z.string().max(40)]).nullish(),
  /** Indian PIN code (six digits); anything else is dropped at normalization. */
  pincode: z.union([z.number(), z.string().max(20)]).nullish(),
  /**
   * The source's own statement about a website (ADR-119): `false` means the listing has none (a
   * Places result without `websiteUri` when it was requested). Absent means the source says
   * nothing. Only `false` with no website value gives NOT_LISTED.
   */
  websiteListed: z.boolean().nullish(),
  /**
   * Google Places place ID (ADR-118). Kept on the lead only for GOOGLE_PLACES records, where it is
   * also the provider id when `providerId` is not given; when both are given they must agree.
   */
  placeId: z.string().trim().min(1).max(256).nullish(),
});
export type IngestFields = z.infer<typeof ingestFieldsSchema>;

const answerValue = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);

export const ingestRecordSchema = z.object({
  externalId: z.string().trim().min(1).max(256),
  providerId: z.string().trim().min(1).max(256).optional(),
  fields: ingestFieldsSchema,
  answers: z.record(z.string().max(200), answerValue).optional(),
  attribution: z.record(z.string().max(64), z.string().max(500)).optional(),
  /** Form submission or provider creation time: the consent evidence time. */
  submittedAt: isoTime.optional(),
  /** When the extension scraped the record. */
  extractedAt: isoTime.optional(),
});
export type IngestRecord = z.infer<typeof ingestRecordSchema>;

export const consentMappingSchema = z.object({
  column: z.string().trim().min(1).max(200),
  truthyValues: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
  channel: z.enum(Channel),
  purpose: z.enum(ConsentPurpose),
  noticeText: z.string().trim().min(1).max(5000),
  noticeTextHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  noticeVersion: z.string().trim().min(1).max(64).optional(),
});
export type ConsentMapping = z.infer<typeof consentMappingSchema>;

export const ingestMappingSchema = z.object({
  /** SheetMapping.version used to map the rows. */
  version: z.number().int().positive().optional(),
  /** Sheet id or Meta form id: consent evidence `formId`. */
  formId: z.string().trim().min(1).max(256).optional(),
  consent: consentMappingSchema.nullish(),
});
export type IngestMapping = z.infer<typeof ingestMappingSchema>;

/** Records per call: the extension cap (200, plan §9) with headroom for Sheets backfills. */
export const MAX_INGEST_RECORDS = 500;

export const ingestBatchSchema = z
  .object({
    source: z.enum(LeadSource),
    externalBatchId: z.string().trim().min(1).max(256),
    simulated: z.boolean().optional(),
    extensionTokenId: z.string().min(1).max(64).nullish(),
    mapping: ingestMappingSchema.optional(),
    records: z.array(ingestRecordSchema).min(1).max(MAX_INGEST_RECORDS),
  })
  .superRefine((batch, ctx) => {
    batch.records.forEach((record, index) => {
      const placeId = record.fields.placeId;
      if (placeId !== null && placeId !== undefined && record.providerId !== undefined && record.providerId !== placeId) {
        ctx.addIssue({ code: 'custom', path: ['records', index, 'fields', 'placeId'], message: 'fields.placeId must equal providerId when both are given' });
      }
    });
  });
export type IngestBatchInput = z.input<typeof ingestBatchSchema>;
export type IngestBatchParsed = z.output<typeof ingestBatchSchema>;
