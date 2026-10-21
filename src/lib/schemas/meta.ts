/**
 * Meta Lead Ads and Marketing API schemas (T35), shared by the webhook receiver, the Meta console
 * routes and its forms (one schema set, plan §2). `workspaceSlug` names one of the caller's own
 * workspaces and is resolved server-side exactly like a `[ws]` segment (ADR-58).
 *
 * - `metaPageWebhookSchema`: the Page webhook delivery (`object: "page"`, entries with `changes`).
 *   Only `field: "leadgen"` changes are lead notifications; their `value` carries ids only
 *   (`metaLeadgenChangeSchema`), never contact data. Shape per Meta's Lead Ads webhooks guide,
 *   read through search snippets only (UNVERIFIED, docs/integrations.md).
 * - Campaign status changes: the target is PAUSED or ACTIVE only (plan "pause/resume only", R44),
 *   confirmed by typing PAUSE or RESUME, with a client request key so a double click or a retry is
 *   one CampaignAction.
 * - Backfill: one Instant Form, leads created after `since` (at most 90 days back: Meta keeps leads
 *   for 90 days, UNVERIFIED).
 * - Form mapping: which question key fills which lead field, and the consent question (P1).
 */
import { z } from 'zod';
import { Channel, ConsentPurpose } from '../domain/enums';
import { fieldMapSchema } from './webhooks/sources';

const workspaceSlug = z.string().trim().min(1).max(100).optional();
/** Graph object ids: digits only, so an id never carries a path or a query into a URL. */
export const META_ID_RE = /^\d{5,32}$/;
const graphId = z.string().trim().regex(META_ID_RE, 'Meta ids are 5 to 32 digits.');
const requestKey = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

// ---- Webhook ----------------------------------------------------------------------------------------

export const metaPageWebhookSchema = z.object({
  object: z.literal('page'),
  entry: z
    .array(
      z.object({
        /** The Page id the notification is about. */
        id: z.string().min(1).max(64),
        time: z.number().optional(),
        changes: z.array(z.object({ field: z.string().min(1).max(64), value: z.unknown() })).max(1000).optional(),
      }),
    )
    .max(1000),
});
export type MetaPageWebhook = z.infer<typeof metaPageWebhookSchema>;

// ---- Campaign controls ------------------------------------------------------------------------------

export const CAMPAIGN_TARGET_STATUSES = ['PAUSED', 'ACTIVE'] as const;
export type CampaignTargetStatus = (typeof CAMPAIGN_TARGET_STATUSES)[number];

/** The word a person types to confirm the change. */
export const CAMPAIGN_CONFIRM_TEXT: Readonly<Record<CampaignTargetStatus, string>> = { PAUSED: 'PAUSE', ACTIVE: 'RESUME' };

/** POST /api/app/campaigns/[campaignId]/status */
export const CampaignStatusBody = z.object({
  workspaceSlug,
  targetStatus: z.enum(CAMPAIGN_TARGET_STATUSES),
  confirm: z.string().trim().max(20),
  requestKey,
});
export type CampaignStatusBody = z.infer<typeof CampaignStatusBody>;

/** POST /api/app/campaigns/sync */
export const CampaignSyncBody = z.object({ workspaceSlug });
export type CampaignSyncBody = z.infer<typeof CampaignSyncBody>;

// ---- Backfill ---------------------------------------------------------------------------------------

/** Meta keeps Instant Form leads for 90 days (UNVERIFIED); a backfill never asks for older ones. */
export const BACKFILL_MAX_AGE_DAYS = 90;

/** POST /api/app/meta/backfill */
export const MetaBackfillBody = z.object({
  workspaceSlug,
  formId: graphId,
  since: z.iso.datetime({ offset: true }),
  requestKey,
});
export type MetaBackfillBody = z.infer<typeof MetaBackfillBody>;

// ---- Form mapping -----------------------------------------------------------------------------------

/** Meta's standard Instant Form question keys (prefilled on the mapping form). */
export const META_STANDARD_FIELD_MAP = { name: 'full_name', phone: 'phone_number', email: 'email', city: 'city' } as const;

export const metaConsentInputSchema = z.object({
  /** A custom question key, or a custom disclaimer checkbox key. */
  question: z.string().trim().min(1).max(200),
  truthyValues: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
  channel: z.enum(Channel),
  purpose: z.enum(ConsentPurpose),
  /** The notice the person agreed to, exactly as the form shows it (its hash is stored, P1). */
  noticeText: z.string().trim().min(10).max(5000),
  noticeVersion: z.string().trim().min(1).max(64).optional(),
});
export type MetaConsentInput = z.infer<typeof metaConsentInputSchema>;

/** POST /api/app/meta/forms: creates or replaces one Instant Form's mapping. */
export const MetaFormMappingBody = z.object({
  workspaceSlug,
  formId: graphId,
  fields: fieldMapSchema,
  consent: metaConsentInputSchema.nullable(),
});
export type MetaFormMappingBody = z.infer<typeof MetaFormMappingBody>;
