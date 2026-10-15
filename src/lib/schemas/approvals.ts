/**
 * Approval queue and quote hand-over request schemas (T22), shared by the /api/app/approvals and
 * /api/app/quotes/[quoteId]/mark-sent routes and the panel forms (plan §2: one schema set). Shape
 * only; the services answer domain rules with 409 / 422 codes.
 */
import { z } from 'zod';
import { QuoteReviseBody } from './quotes';

const slug = z.string().min(1).max(80);
const id = z.string().min(1).max(64);

export const APPROVAL_REASON = { min: 3, max: 500 } as const;

/** Approve a quote version from the queue: `expectedVersion` is the version on screen (409 when stale). */
export const ApprovalApproveBody = z.object({ workspaceSlug: slug.optional(), expectedVersion: z.number().int().min(1) });
export type ApprovalApproveBody = z.output<typeof ApprovalApproveBody>;

/** Approve and send: a quote needs the version on screen and a channel (WhatsApp also a template); a message draft needs neither. */
export const ApprovalSendBody = z.object({
  workspaceSlug: slug.optional(),
  expectedVersion: z.number().int().min(1).optional(),
  channel: z.enum(['WHATSAPP', 'EMAIL']).optional(),
  templateId: id.optional(),
});
export type ApprovalSendBody = z.output<typeof ApprovalSendBody>;

export const ApprovalRejectBody = z.object({
  workspaceSlug: slug.optional(),
  reason: z.string().trim().min(APPROVAL_REASON.min, `Give a reason of at least ${APPROVAL_REASON.min} characters.`).max(APPROVAL_REASON.max),
});
export type ApprovalRejectBody = z.output<typeof ApprovalRejectBody>;

/** Edit the quote behind a queue item (a new version, priced by the server within the editor's permissions). */
export const ApprovalReviseBody = QuoteReviseBody.extend({ workspaceSlug: slug.optional() });
export type ApprovalReviseBody = z.output<typeof ApprovalReviseBody>;

/** P15: the business handed the quotation over itself (copied link or its own channel). */
export const QuoteMarkSentBody = z.object({ expectedVersion: z.number().int().min(1), via: z.enum(['COPY_LINK', 'MARK_SENT']) });
export type QuoteMarkSentBody = z.output<typeof QuoteMarkSentBody>;
