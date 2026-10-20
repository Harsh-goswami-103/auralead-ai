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

/**
 * Who wrote a draft or an outbound message (`AiDraft.generatorLabel`, `Message.generatorLabel`),
 * shared by the lead detail and the approval queue so the same text is never "AI" on one page and
 * a template on another. Only real model providers are AI; the local deterministic generator, the
 * reply guard (fixed texts and catalog facts) and system texts say what they are (truthful UI).
 */
export type GeneratorKind = 'ai' | 'template' | 'automatic' | 'system' | 'human' | 'none' | 'other';

export type GeneratorInfo = {
  kind: GeneratorKind;
  /** Full name, e.g. on the lead detail's draft line. */
  label: string;
  /** Chip text in lists, e.g. "AI prepared" or "Local template". */
  short: string;
};

export const GENERATOR_LABELS: Readonly<Record<string, GeneratorInfo>> = {
  anthropic: { kind: 'ai', label: 'Anthropic', short: 'AI prepared' },
  openai: { kind: 'ai', label: 'OpenAI', short: 'AI prepared' },
  'local-deterministic': { kind: 'template', label: 'Local template (deterministic)', short: 'Local template' },
  'reply-guard': { kind: 'automatic', label: 'Automatic reply (fixed texts and catalog facts)', short: 'Automatic reply' },
  system: { kind: 'system', label: 'System text', short: 'System text' },
  human: { kind: 'human', label: 'Written by a person', short: 'Written by a person' },
  none: { kind: 'none', label: 'Not generated', short: 'Not generated' },
};

/** The vocabulary entry for a generator label; an unknown label keeps its own text and is never called AI. */
export function generatorInfo(label: string | null | undefined): GeneratorInfo {
  if (label === null || label === undefined || label === '') return GENERATOR_LABELS.none!;
  if (Object.hasOwn(GENERATOR_LABELS, label)) return GENERATOR_LABELS[label]!;
  return { kind: 'other', label, short: label };
}
