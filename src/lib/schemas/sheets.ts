/**
 * Google Sheets setup (T34; plan §5.3 SheetMapping, P1, P14, PRD "Sheets/Form setup"): the request
 * bodies of `/api/app/sheets/*`, shared by the routes and the mapping form (one schema set, plan
 * §2), and the header-name normalization the server, the form and the generated Apps Script all
 * use. Framework-free and browser-safe (no crypto: the fingerprint is computed on the server).
 *
 * Header names are compared after `normalizeHeaderName` (Unicode NFKC, runs of white space folded
 * to one space, trimmed), so "Phone  number " and "Phone number" are the same column. Case is kept:
 * the mapping reads values by the exact normalized name.
 */
import { z } from 'zod';
import { Channel, ConsentPurpose } from '../domain/enums';
import { MAPPABLE_FIELDS } from './webhooks/sources';

/** The hidden column the generated Apps Script writes each row's stable event id into. Never mappable. */
export const SHEETS_EVENT_ID_COLUMN = 'auralead_event_id';
/** Rows a preview (dry run) parses. */
export const SHEETS_PREVIEW_ROWS = 10;
/** Rows one "Sync now" run reads at most. */
export const SHEETS_SYNC_MAX_ROWS = 200;
/** Header names longer than this are cut (a header cell is a label, not data). */
export const SHEETS_HEADER_NAME_MAX = 200;

export function normalizeHeaderName(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, SHEETS_HEADER_NAME_MAX);
}

const workspaceSlug = z.string().trim().min(1).max(100).optional();
const column = z
  .string()
  .max(SHEETS_HEADER_NAME_MAX * 2)
  .transform(normalizeHeaderName)
  .pipe(z.string().min(1, 'Choose a column.'));

export const sheetsConsentInputSchema = z.object({
  column,
  truthyValues: z.array(z.string().trim().min(1).max(100)).min(1, 'List at least one answer that means yes.').max(20),
  channel: z.enum(Channel),
  purpose: z.enum(ConsentPurpose),
  /** The notice exactly as the form shows it next to the question (stored verbatim and hashed, P1). */
  noticeText: z.string().trim().min(1, 'Paste the notice text the form shows.').max(5000),
  noticeVersion: z.string().trim().min(1).max(64).optional(),
});
export type SheetsConsentInput = z.infer<typeof sheetsConsentInputSchema>;

export const sheetsMappingInputSchema = z.object({
  /** Lead field -> Sheet column. */
  fieldMap: z.partialRecord(z.enum(MAPPABLE_FIELDS), column),
  /** The column with the form submission time (Google Forms: "Timestamp"); needed for consent evidence. */
  submittedAtColumn: column.nullable(),
  /** The WhatsApp or email opt-in question (P1); null means rows never record consent. */
  consent: sheetsConsentInputSchema.nullable(),
});
export type SheetsMappingInput = z.infer<typeof sheetsMappingInputSchema>;

/** POST /api/app/sheets/header: read row 1 of the Sheet through the service account. */
export const SheetsHeaderBody = z.object({ workspaceSlug });
export type SheetsHeaderBody = z.infer<typeof SheetsHeaderBody>;

/** POST /api/app/sheets/preview: dry run of the next rows with the active or a proposed mapping. Writes nothing. */
export const SheetsPreviewBody = z.object({ workspaceSlug, mapping: sheetsMappingInputSchema.optional() });
export type SheetsPreviewBody = z.infer<typeof SheetsPreviewBody>;

/**
 * POST /api/app/sheets/mapping: confirm a mapping as the new active version. `headerFingerprint` is
 * the fingerprint of the header the form was built from (the server re-reads the header and
 * refuses a mapping made for different columns); `expectedVersion` is the active version the form
 * started from (0 when none), so two editors cannot overwrite each other silently.
 */
export const SheetsMappingBody = z.object({
  workspaceSlug,
  expectedVersion: z.number().int().min(0),
  headerFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  mapping: sheetsMappingInputSchema,
});
export type SheetsMappingBody = z.infer<typeof SheetsMappingBody>;

/** POST /api/app/sheets/sync: "Sync now". */
export const SheetsSyncBody = z.object({ workspaceSlug });
export type SheetsSyncBody = z.infer<typeof SheetsSyncBody>;

export const APPS_SCRIPT_ROTATE_CONFIRMATION = 'ROTATE';

/** POST /api/app/sheets/apps-script/secret: issue the signing secret, or rotate it (typed ROTATE). */
export const AppsScriptSecretBody = z.object({ workspaceSlug, confirm: z.literal(APPS_SCRIPT_ROTATE_CONFIRMATION).optional() });
export type AppsScriptSecretBody = z.infer<typeof AppsScriptSecretBody>;
