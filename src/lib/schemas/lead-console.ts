/**
 * Request schemas for the lead console routes under /api/app/leads/[leadId]/** (T17), shared by
 * the route handlers and the console buttons (plan §2: one schema set). Shape only; domain rules
 * (capabilities, proposal contents, version CAS) are the services' and answer with a code.
 *
 * `workspaceSlug` selects one of the caller's own workspaces exactly like a `[ws]` segment
 * (membership, or an active employee assignment); a slug the caller has no access to is 404. When
 * it is absent the session's active workspace is used.
 */
import { z } from 'zod';

const id = z.string().min(1).max(64);
export const workspaceSlugField = z.string().trim().min(1).max(100);

export const LeadDraftBody = z.object({
  workspaceSlug: workspaceSlugField.optional(),
  /** "Generate with local template" (C13): the deterministic local generator, labelled as such. */
  local: z.boolean().optional().default(false),
});
export type LeadDraftBody = z.output<typeof LeadDraftBody>;

export const LeadQuoteFromProposalBody = z.object({ workspaceSlug: workspaceSlugField.optional(), draftId: id });
export type LeadQuoteFromProposalBody = z.output<typeof LeadQuoteFromProposalBody>;

export const LeadQuoteApproveBody = z.object({ workspaceSlug: workspaceSlugField.optional(), expectedVersion: z.number().int().min(1) });
export type LeadQuoteApproveBody = z.output<typeof LeadQuoteApproveBody>;

export const LeadQuotePdfQuery = z.object({
  workspaceSlug: workspaceSlugField.optional(),
  version: z.coerce.number().int().min(1).max(100_000).optional(),
});
export type LeadQuotePdfQuery = z.output<typeof LeadQuotePdfQuery>;

/** The console's PDF download URL for a quote of a lead (the current version unless `version`). */
export function leadQuotePdfHref(leadId: string, quoteId: string, workspaceSlug: string, version?: number): string {
  const q = new URLSearchParams({ workspaceSlug });
  if (version !== undefined) q.set('version', String(version));
  return `/api/app/leads/${encodeURIComponent(leadId)}/quotes/${encodeURIComponent(quoteId)}/pdf?${q.toString()}`;
}
