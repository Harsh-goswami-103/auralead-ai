/**
 * Inbox request schemas (T22; ADR-121), shared by /api/app/{messages,conversations,settings/auto-send}
 * and the inbox forms (plan §2: one schema set). Shape only; content rules per channel are the inbox
 * service's (422 / 400 with a code). `workspaceSlug` names the operator's assigned workspace in the
 * employee panel (resolved server-side like a `[ws]` segment); the client panel omits it.
 */
import { z } from 'zod';
import { workspaceSlugField } from './lead-console';

const id = z.string().min(1).max(64);
const workspaceSlug = workspaceSlugField.optional();

/** One request key per composer submission: retries and double clicks reuse it (one dispatch). */
export const REQUEST_KEY = /^[A-Za-z0-9_-]{8,64}$/;

const content = {
  kind: z.enum(['TEXT', 'TEMPLATE', 'EMAIL']),
  body: z.string().max(10_000).optional(),
  subject: z.string().max(200).optional(),
  templateId: id.optional(),
  variables: z.record(z.string().max(64), z.string().max(1024)).optional(),
};

export const ComposerSendBody = z.object({ conversationId: id, requestKey: z.string().regex(REQUEST_KEY, 'Invalid request key.'), workspaceSlug, ...content });
export type ComposerSendBody = z.output<typeof ComposerSendBody>;

export const ComposerDraftBody = z.object({ conversationId: id, workspaceSlug, ...content });
export type ComposerDraftBody = z.output<typeof ComposerDraftBody>;

export const ConversationModeVersionBody = z.object({ expectedModeVersion: z.number().int().min(0).optional(), workspaceSlug });
export type ConversationModeVersionBody = z.output<typeof ConversationModeVersionBody>;

export const ConversationAiModeBody = z.object({ aiMode: z.enum(['OFF', 'DRAFT', 'AUTO']), expectedModeVersion: z.number().int().min(0).optional(), workspaceSlug });
export type ConversationAiModeBody = z.output<typeof ConversationAiModeBody>;

/** "Automatic sending" (ADR-121): the workspace's audited auto-send opt-in. */
export const AutoSendBody = z.object({ enabled: z.boolean(), workspaceSlug });
export type AutoSendBody = z.output<typeof AutoSendBody>;
