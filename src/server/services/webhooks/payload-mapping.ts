/**
 * Maps a decrypted lead-source webhook payload onto the ingestion contract (`IngestBatchInput`),
 * using the source's stored mapping. Shared by `ingest.process` and the live receivers' tests
 * (T34-T36). Pure: the caller loads the mapping rows.
 *
 * - Sheets: the push's `mappingVersion` selects the integration's SheetMapping; its `fieldMap`
 *   names the column for each lead field and its `consentMapping` (P1) is passed through, with the
 *   raw row as the answers. Batch id = the push event id, record id = the row key.
 * - Meta: the form's MetaFormMapping maps question keys; answers are the `field_data` values.
 *   Batch id = `meta:{page}:{leadgen}`, record id = the leadgen id, evidence time = the lead's
 *   `created_time`.
 * - Maps extension: fixed field names, the place id as the provider key, no consent (Maps leads
 *   never get WhatsApp consent, ADR-15). Batch id = the extension batch id.
 */
import type { IngestBatchInput, IngestFields, ConsentMapping } from '@/lib/schemas/ingest';
import { consentMappingSchema } from '@/lib/schemas/ingest';
import {
  extensionBatchSchema,
  fieldMapSchema,
  metaLeadEventSchema,
  sheetsPushSchema,
  type ExtensionBatch,
  type FieldMap,
  type MetaLeadEvent,
  type SheetsPush,
} from '@/lib/schemas/webhooks';

/** A payload that cannot be mapped: the event is marked FAILED with this code (never retried). */
export class PayloadMappingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PayloadMappingError';
    this.code = code;
  }
}

export type StoredMapping = { version?: number; fieldMap: unknown; consentMapping: unknown };

type AnswerValue = string | number | boolean | null;

function textOf(value: AnswerValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function parseFieldMap(raw: unknown): FieldMap {
  const parsed = fieldMapSchema.safeParse(raw);
  if (!parsed.success) throw new PayloadMappingError('MAPPING_INVALID', 'the stored field map is not a valid lead field mapping');
  return parsed.data;
}

function parseConsent(raw: unknown): ConsentMapping | null {
  if (raw === null || raw === undefined) return null;
  const parsed = consentMappingSchema.safeParse(raw);
  if (!parsed.success) throw new PayloadMappingError('MAPPING_INVALID', 'the stored consent mapping is not valid');
  return parsed.data;
}

function mapFields(fieldMap: FieldMap, answers: Readonly<Record<string, AnswerValue>>): IngestFields {
  const fields: IngestFields = {};
  for (const [field, key] of Object.entries(fieldMap) as Array<[keyof FieldMap, string | undefined]>) {
    if (key === undefined) continue;
    fields[field] = textOf(answers[key]);
  }
  return fields;
}

function parseOr<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new PayloadMappingError('INVALID_PAYLOAD', `the stored ${what} payload does not match its schema`);
  return parsed.data;
}

export function parseSheetsPush(body: unknown): SheetsPush {
  return parseOr(sheetsPushSchema, body, 'Sheets push');
}

export function parseMetaLeadEvent(body: unknown): MetaLeadEvent {
  return parseOr(metaLeadEventSchema, body, 'Meta lead');
}

export function parseExtensionBatch(body: unknown): ExtensionBatch {
  return parseOr(extensionBatchSchema, body, 'extension batch');
}

export function sheetsToIngest(push: SheetsPush, mapping: StoredMapping, opts: { externalBatchId: string; simulated: boolean }): IngestBatchInput {
  const fieldMap = parseFieldMap(mapping.fieldMap);
  const consent = parseConsent(mapping.consentMapping);
  return {
    source: 'GOOGLE_SHEETS',
    externalBatchId: opts.externalBatchId,
    simulated: opts.simulated,
    mapping: { version: mapping.version ?? push.mappingVersion, formId: push.sheetId, consent },
    records: push.rows.map((row) => ({
      externalId: row.rowKey,
      fields: mapFields(fieldMap, row.values),
      answers: row.values,
      // T34: a row identified by a content hash (no auralead_event_id) is flagged on its source record.
      attribution: { sheet: push.sheetId, ...(row.weakId ? { weakId: 'content-hash' } : {}) },
      ...(row.submittedAt ? { submittedAt: row.submittedAt } : {}),
    })),
  };
}

/** Graph API `created_time` (`2026-10-16T05:59:00+0000`) as an ISO instant, or undefined if unparseable. */
export function graphTimeToIso(value: string): string | undefined {
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const at = new Date(normalized);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

export function metaToIngest(event: MetaLeadEvent, mapping: StoredMapping, opts: { externalBatchId: string; simulated: boolean }): IngestBatchInput {
  if (event.lead.id !== event.change.leadgen_id) throw new PayloadMappingError('INVALID_PAYLOAD', 'the retrieved lead does not match the leadgen notification');
  const fieldMap = parseFieldMap(mapping.fieldMap);
  const consent = parseConsent(mapping.consentMapping);
  const answers: Record<string, string> = {};
  for (const field of event.lead.field_data) answers[field.name] = field.values.join(', ');
  const submittedAt = graphTimeToIso(event.lead.created_time);
  const attribution: Record<string, string> = { page: event.change.page_id, form: event.change.form_id };
  if (event.lead.ad_id ?? event.change.ad_id) attribution.ad = (event.lead.ad_id ?? event.change.ad_id)!;
  if (event.lead.campaign_id) attribution.campaign = event.lead.campaign_id;
  return {
    source: 'META_ADS',
    externalBatchId: opts.externalBatchId,
    simulated: opts.simulated,
    mapping: { formId: event.change.form_id, consent },
    records: [
      {
        externalId: event.change.leadgen_id,
        fields: mapFields(fieldMap, answers),
        answers,
        attribution,
        ...(submittedAt ? { submittedAt } : {}),
      },
    ],
  };
}

export function extensionToIngest(batch: ExtensionBatch, opts: { simulated: boolean; extensionTokenId?: string | null }): IngestBatchInput {
  return {
    source: 'GMAPS_EXTENSION',
    externalBatchId: batch.batchId,
    simulated: opts.simulated,
    extensionTokenId: opts.extensionTokenId ?? null,
    records: batch.records.map((r) => ({
      externalId: r.recordId,
      ...(r.placeId ? { providerId: r.placeId } : {}),
      fields: {
        name: r.name ?? null,
        phone: r.phone ?? null,
        email: r.email ?? null,
        website: r.website ?? null,
        address: r.address ?? null,
        city: r.city ?? null,
        category: r.category ?? null,
        rating: r.rating ?? null,
        reviewCount: r.reviewCount ?? null,
      },
      ...(batch.keyword ? { attribution: { keyword: batch.keyword } } : {}),
      ...(r.extractedAt ? { extractedAt: r.extractedAt } : {}),
    })),
  };
}
