/**
 * Maps extension live receiver and token management (T36; plan §9 Extension, C14, C18).
 *
 * - Intake envelope: `{version: 1, batchId, keyword?, records[]}`. The envelope is validated as a
 *   whole (400 otherwise), the record count is capped before anything else (more than 200 is 413),
 *   and every record is then validated on its own with `extensionRecordSchema`, so one malformed
 *   record is rejected alone (`INVALID_RECORD`) and never fails the batch.
 * - Stored body: the valid records plus a server-written `intake` block (the authenticated token
 *   and the intake rejections). `ingest.process` reads it to set ImportBatch.extensionTokenId and
 *   to report the intake rejections next to the ingestion results.
 * - Token routes: create (name, optional allowed Chrome extension id, optional expiry), revoke
 *   (typed `REVOKE`) and the allowed extension id.
 */
import { z } from 'zod';

export const EXTENSION_SCOPE = 'ingest:gmaps';
/** Batch ids are client-generated (the bridge uses a UUID); a conservative charset. */
export const EXTENSION_BATCH_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** A Chrome extension id: 32 letters a-p. */
export const CHROME_EXTENSION_ID_RE = /^[a-p]{32}$/;
export const EXTENSION_TOKEN_ACTIVE_LIMIT = 10;
export const EXTENSION_TOKEN_REVOKE_CONFIRMATION = 'REVOKE';
export const EXTENSION_TOKEN_EXPIRY_DAYS = [30, 90, 365] as const;
export const EXTENSION_WEBHOOK_PATH = '/api/webhooks/gmaps-extension';

export const extensionEnvelopeSchema = z.object({
  version: z.literal(1),
  batchId: z.string().regex(EXTENSION_BATCH_ID_RE),
  keyword: z.string().max(200).optional(),
  records: z.array(z.unknown()).min(1),
});
export type ExtensionEnvelope = z.infer<typeof extensionEnvelopeSchema>;

export type ExtensionIntakeRejection = { index: number; recordId: string | null; reasonCode: 'INVALID_RECORD'; fields: string[] };

export const extensionIntakeMetaSchema = z.object({
  extensionTokenId: z.string().min(1).max(64),
  rejected: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        recordId: z.string().max(256).nullable(),
        reasonCode: z.literal('INVALID_RECORD'),
        fields: z.array(z.string().max(64)).max(32),
      }),
    )
    .max(200),
});
export type ExtensionIntakeMeta = z.infer<typeof extensionIntakeMetaSchema>;

const slug = z.string().trim().min(1).max(100).optional();
const extensionId = z.string().trim().regex(CHROME_EXTENSION_ID_RE, 'A Chrome extension id is 32 letters from a to p.');

export const ExtensionTokenCreateBody = z.object({
  workspaceSlug: slug,
  name: z.string().trim().min(1, 'Name the token (for example the laptop it is used on).').max(80),
  allowedExtensionId: extensionId.nullish(),
  expiresInDays: z
    .union([z.literal(30), z.literal(90), z.literal(365)])
    .nullish(),
});
export type ExtensionTokenCreateInput = z.infer<typeof ExtensionTokenCreateBody>;

export const ExtensionTokenRevokeBody = z.object({
  workspaceSlug: slug,
  confirm: z.literal(EXTENSION_TOKEN_REVOKE_CONFIRMATION),
});

export const ExtensionAllowedIdBody = z.object({
  workspaceSlug: slug,
  allowedExtensionId: extensionId.nullable(),
});
