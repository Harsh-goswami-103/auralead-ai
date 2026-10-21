/**
 * Lead-source webhook payloads (T11), shared by the DEMO simulators and the live receivers
 * (Sheets Apps Script T34, Meta Lead Ads T35, Maps extension T36). Each schema is the parsed
 * body that `WebhookEvent.processingPayload` stores encrypted (E1); `ingest.process` decrypts it
 * and maps it onto `IngestBatchInput` with the source's mapping.
 *
 * - Sheets (Apps Script push, v1): one event per sync run, `eventId` is the `auralead_event_id`
 *   the script generates, rows carry the raw header -> value map and the form submission time.
 * - Meta (one event per leadgen): the `leadgen` change value from the Page webhook plus the lead
 *   retrieved from the Graph API (`GET /{leadgen_id}`: `id`, `created_time`, `field_data`).
 *   The webhook itself carries no contact data, so the processing payload needs the lead.
 * - Maps extension (v1): one event per batch, records keyed by the extension's stable `recordId`
 *   with the Maps place id when known.
 * Caps follow plan §9 / C14: Sheets 50 rows, extension 200 records.
 */
import { z } from 'zod';

const answerValue = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);
const isoTime = z.iso.datetime({ offset: true });
const id = (max = 256) => z.string().trim().min(1).max(max);

export const SHEETS_MAX_ROWS = 50;
/** Header columns a push may name (T34). */
export const SHEETS_MAX_COLUMNS = 200;
export const EXTENSION_MAX_RECORDS = 200;

const sheetsRowValues = z.record(z.string().max(200), answerValue);
/** Row 1 of the Sheet as the script read it (T34): the receiver checks it against the mapping's header fingerprint (drift). */
const sheetsHeader = z.array(z.string().max(200)).max(SHEETS_MAX_COLUMNS);

export const sheetsPushSchema = z.object({
  version: z.literal(1),
  eventId: id(),
  sheetId: id(),
  /** SheetMapping.version the script was generated for. */
  mappingVersion: z.number().int().positive(),
  /** T34 extension; absent on pushes stored before it. */
  header: sheetsHeader.optional(),
  rows: z
    .array(
      z.object({
        /** Stable per sheet row (the script's `auralead_event_id`), the record's idempotency key. */
        rowKey: id(),
        /**
         * T34: true when the push carried no row id and the receiver derived `rowKey` from the row's
         * content (a weak id: an edited row gets a new one). Set by the server only.
         */
        weakId: z.boolean().optional(),
        submittedAt: isoTime.optional(),
        values: sheetsRowValues,
      }),
    )
    .min(1)
    .max(SHEETS_MAX_ROWS),
});
export type SheetsPush = z.infer<typeof sheetsPushSchema>;

/**
 * What an Apps Script may send to /api/webhooks/google-sheets (T34): the stored shape, except that
 * a row may lack its `rowKey` (the receiver then derives a weak content-hash id and flags it), and
 * `weakId` is never accepted from the caller (unknown keys are stripped).
 */
export const sheetsPushInSchema = z.object({
  version: z.literal(1),
  eventId: id(),
  sheetId: id(),
  mappingVersion: z.number().int().positive(),
  header: sheetsHeader.optional(),
  rows: z
    .array(z.object({ rowKey: id().optional(), submittedAt: isoTime.optional(), values: sheetsRowValues }))
    .min(1)
    .max(SHEETS_MAX_ROWS),
});
export type SheetsPushIn = z.infer<typeof sheetsPushInSchema>;

/** The `value` of a Page webhook change with `field: "leadgen"`. */
export const metaLeadgenChangeSchema = z.object({
  leadgen_id: id(64),
  page_id: id(64),
  form_id: id(64),
  ad_id: id(64).optional(),
  adgroup_id: id(64).optional(),
  /** Unix seconds. */
  created_time: z.number().int().nonnegative(),
});
export type MetaLeadgenChange = z.infer<typeof metaLeadgenChangeSchema>;

/** `GET /{leadgen_id}` result (Graph API Lead): `created_time` like `2026-10-16T05:59:00+0000`. */
export const metaLeadSchema = z.object({
  id: id(64),
  created_time: z.string().min(10).max(40),
  form_id: id(64).optional(),
  ad_id: id(64).optional(),
  campaign_id: id(64).optional(),
  field_data: z
    .array(z.object({ name: z.string().min(1).max(200), values: z.array(z.string().max(2000)).max(20) }))
    .max(100),
});
export type MetaLead = z.infer<typeof metaLeadSchema>;

export const metaLeadEventSchema = z.object({
  change: metaLeadgenChangeSchema,
  lead: metaLeadSchema,
});
export type MetaLeadEvent = z.infer<typeof metaLeadEventSchema>;

export const extensionBatchSchema = z.object({
  version: z.literal(1),
  batchId: id(128),
  /** Search keyword the records were scraped for (attribution). */
  keyword: z.string().max(200).optional(),
  records: z
    .array(
      z.object({
        recordId: id(),
        placeId: id().optional(),
        name: z.string().max(300).nullish(),
        phone: z.string().max(300).nullish(),
        email: z.string().max(320).nullish(),
        website: z.string().max(2048).nullish(),
        address: z.string().max(1000).nullish(),
        city: z.string().max(200).nullish(),
        category: z.string().max(200).nullish(),
        rating: z.union([z.number(), z.string().max(20)]).nullish(),
        reviewCount: z.union([z.number(), z.string().max(40)]).nullish(),
        extractedAt: isoTime.optional(),
      }),
    )
    .min(1)
    .max(EXTENSION_MAX_RECORDS),
});
export type ExtensionBatch = z.infer<typeof extensionBatchSchema>;

/** Lead fields a Sheets or Meta form mapping can fill: field -> column header or question key. */
export const MAPPABLE_FIELDS = ['name', 'phone', 'email', 'website', 'address', 'city', 'category'] as const;
export type MappableField = (typeof MAPPABLE_FIELDS)[number];
export const fieldMapSchema = z.partialRecord(z.enum(MAPPABLE_FIELDS), z.string().trim().min(1).max(200));
export type FieldMap = z.infer<typeof fieldMapSchema>;
