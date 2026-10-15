/**
 * Bulk action schemas (T23), shared by the `/api/app/bulk/**` routes, the bulk service and the
 * panels (plan §2: one schema set), plus the result DTO the `BulkResultSummary` drawer renders.
 *
 * A bulk action applies one send to a lead selection: a WhatsApp template (with fixed variable
 * values) or an email (subject and body; the unsubscribe footer is added at dispatch). Shape only;
 * eligibility per row is the shared dispatch eligibility function with sendIntent BULK.
 */
import { z } from 'zod';
import { workspaceSlugField } from './lead-console';

export const BULK_MAX_SELECTION = 500;

const id = z.string().min(1).max(64);

export const BulkLeadIds = z
  .array(id)
  .min(1, 'Select at least one lead.')
  .max(BULK_MAX_SELECTION, `Select at most ${BULK_MAX_SELECTION} leads.`)
  .refine((ids) => new Set(ids).size === ids.length, 'Each lead can be selected once.');

/** WhatsApp template body variables by position ("1", "2", ...), the same value for every row. */
export const BulkTemplateVariables = z.record(z.string().regex(/^[1-9]\d?$/), z.string().trim().min(1).max(200));

const sendTemplate = z.object({
  action: z.literal('SEND_WHATSAPP_TEMPLATE'),
  templateId: id,
  variables: BulkTemplateVariables.default({}),
});
const sendEmail = z.object({
  action: z.literal('SEND_EMAIL'),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
});

export const BulkActionInput = z.discriminatedUnion('action', [
  sendTemplate.extend({ leadIds: BulkLeadIds }),
  sendEmail.extend({ leadIds: BulkLeadIds }),
]);
export type BulkActionInput = z.output<typeof BulkActionInput>;

export const BulkPreflightBody = z.discriminatedUnion('action', [
  sendTemplate.extend({ leadIds: BulkLeadIds, workspaceSlug: workspaceSlugField.optional() }),
  sendEmail.extend({ leadIds: BulkLeadIds, workspaceSlug: workspaceSlugField.optional() }),
]);
export type BulkPreflightBody = z.output<typeof BulkPreflightBody>;

/** A client-generated key per confirm dialog: a double click or retry returns the same run. */
export const BulkRequestKey = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'requestKey must be 8-64 letters, digits, _ or -');

export const BulkRunRequest = z.discriminatedUnion('action', [
  sendTemplate.extend({ leadIds: BulkLeadIds, requestKey: BulkRequestKey }),
  sendEmail.extend({ leadIds: BulkLeadIds, requestKey: BulkRequestKey }),
]);
export type BulkRunRequest = z.output<typeof BulkRunRequest>;

export const BulkRunBody = z.discriminatedUnion('action', [
  sendTemplate.extend({ leadIds: BulkLeadIds, requestKey: BulkRequestKey, workspaceSlug: workspaceSlugField.optional() }),
  sendEmail.extend({ leadIds: BulkLeadIds, requestKey: BulkRequestKey, workspaceSlug: workspaceSlugField.optional() }),
]);
export type BulkRunBody = z.output<typeof BulkRunBody>;

export type BulkReason = { code: string; label: string };
export type BulkReasonCount = BulkReason & { count: number };

export type BulkPreflightRow = { leadId: string; leadName: string | null; outcome: 'ELIGIBLE' | 'SKIPPED' | 'FAILED'; reasons: string[]; deferred: boolean };
export type BulkPreflightDto = {
  selected: number;
  eligible: number;
  skipped: number;
  failed: number;
  rows: BulkPreflightRow[];
  byReason: BulkReasonCount[];
};

export type BulkRunRowDto = {
  leadId: string;
  leadName: string | null;
  outcome: 'QUEUED' | 'SKIPPED' | 'FAILED';
  reasons: BulkReason[];
  /** Queued, but its dispatch waits (outbound or automation pause, internal cap). */
  deferred: boolean;
  messageId: string | null;
};

export type BulkRunDto = {
  id: string;
  action: 'SEND_WHATSAPP_TEMPLATE' | 'SEND_EMAIL';
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED';
  selected: number;
  queued: number;
  skipped: number;
  failed: number;
  preflight: { eligible: number; skipped: number; failed: number };
  rows: BulkRunRowDto[];
  byReason: BulkReasonCount[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

/** Query of the GET routes: the workspace, chosen exactly like the lead console routes. */
export const BulkRunQuery = z.object({ workspaceSlug: workspaceSlugField.optional() });
export type BulkRunQuery = z.output<typeof BulkRunQuery>;
