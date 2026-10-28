/**
 * One lead as the Leads detail sheet and page show it (T26, R31, plan §11 M4), read through the
 * tenant-scoped context (`leads.read`):
 *  - the lead's facts, its sales stage with the `stageVersion` the stage control sends back;
 *  - the score breakdown stored with the score (reasons, unknown inputs, config version);
 *  - consent per channel, matched by the contact HMAC exactly as eligibility matches it (an
 *    active suppression first, then opt-in, attested B2B email, or a customer's own message);
 *    shown for context only, the send-time eligibility check stays the authority;
 *  - the source records it came from (source, status, attribution, batch), never the raw payload;
 *  - its quotations and conversations, for links.
 * The sales stage, consent and delivery are independent (R4): nothing here derives one from another.
 */
import type { Channel, ConsentBasis } from '@/generated/prisma/client';
import type { AppConfig } from '@/lib/config';
import { NotFoundError } from '@/lib/errors';
import type { ConsentChannelDto, ConsentState, LeadProfileDto } from '@/lib/schemas/leads';
import { serializePaise } from '@/lib/money';
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireCapability, requireWorkspace } from '@/server/auth/guards';
import { contactKey, ContactKeyError } from '@/server/security/contact-key';
import { attributionList } from '@/server/services/lead-finder/runs';
import { effectiveQuoteStatus } from '@/server/services/quotes/versioning';

export type LeadProfileDeps = { contactKeyPepper: string };

export function leadProfileDeps(config: AppConfig): LeadProfileDeps {
  const pepper = config.secrets.suppressionPepper;
  if (!pepper) throw new Error('SUPPRESSION_PEPPER is not configured (run `npm run setup`).');
  return { contactKeyPepper: pepper };
}

export type { ConsentState, LeadProfileDto } from '@/lib/schemas/leads';
export type LeadProfile = LeadProfileDto;

type JsonRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is JsonRecord => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const BASIS_STATE: Readonly<Record<ConsentBasis, ConsentState>> = { OPT_IN: 'OPT_IN', B2B_ATTESTED: 'B2B_ATTESTED', INBOUND_MESSAGE: 'CUSTOMER_MESSAGED' };
const STATE_RANK: Readonly<Record<ConsentState, number>> = { OPT_IN: 3, B2B_ATTESTED: 2, CUSTOMER_MESSAGED: 1, NONE: 0, OPTED_OUT: 0, NO_CONTACT: 0 };

function keyOf(pepper: string, channel: Channel, value: string | null): string | null {
  if (!value) return null;
  try {
    return contactKey(pepper, channel === 'WHATSAPP' ? 'phone' : 'email', value);
  } catch (error) {
    if (error instanceof ContactKeyError) return null;
    throw error;
  }
}

async function consentFor(ctx: AppCtx, channel: Channel, key: string | null, now: Date): Promise<ConsentChannelDto> {
  if (key === null) return { channel, state: 'NO_CONTACT', since: null, source: null };
  const [suppression, records] = await Promise.all([
    ctx.db.suppression.findFirst({ where: { channel, contactKey: key, clearedAt: null }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, reason: true } }),
    ctx.db.consentRecord.findMany({ where: { channel, contactKey: key, withdrawnAt: null, collectedAt: { lte: now } }, orderBy: { collectedAt: 'desc' } }),
  ]);
  if (suppression) return { channel, state: 'OPTED_OUT', since: suppression.createdAt.toISOString(), source: suppression.reason };
  let best: ConsentChannelDto = { channel, state: 'NONE', since: null, source: null };
  for (const r of records) {
    // As eligibility decides (ADR-73): a WhatsApp opt-in is an opt-in (template sends) only for
    // MARKETING, otherwise it is a service conversation the customer started; an email opt-in is an
    // opt-in whatever its purpose.
    const state = channel === 'WHATSAPP' && r.basis === 'OPT_IN' && r.purpose !== 'MARKETING' ? 'CUSTOMER_MESSAGED' : BASIS_STATE[r.basis];
    if (STATE_RANK[state] > STATE_RANK[best.state]) best = { channel, state, since: r.collectedAt.toISOString(), source: r.source };
  }
  return best;
}

function attributionOf(value: unknown): Array<{ key: string; value: string }> {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
    .map(([key, v]) => ({ key, value: String(v) }));
}

export async function loadLeadProfile(ctx: AppCtx, leadId: string, deps: LeadProfileDeps): Promise<LeadProfileDto> {
  requireCapability(ctx, 'leads.read');
  const workspaceId = requireWorkspace(ctx);
  const lead = await ctx.db.lead.findFirst({ where: { id: leadId } });
  if (!lead) throw new NotFoundError();
  const now = ctx.clock.now();

  const [workspace, scoreConfig, sources, quotes, conversations, whatsapp, email, placeResult] = await Promise.all([
    ctx.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { id: true, slug: true, name: true, timezone: true } }),
    lead.scoreConfigVersionId ? ctx.db.scoringConfigVersion.findFirst({ where: { id: lead.scoreConfigVersionId }, select: { version: true } }) : Promise.resolve(null),
    ctx.db.leadSourceRecord.findMany({ where: { leadId }, orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: 20, include: { importBatch: { select: { externalBatchId: true, simulated: true } } } }),
    ctx.db.quote.findMany({ where: { leadId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: { currentVersion: { select: { totalPaise: true } } } }),
    ctx.db.conversation.findMany({ where: { leadId, closedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, channel: true, lastInboundProviderAt: true } }),
    consentFor(ctx, 'WHATSAPP', keyOf(deps.contactKeyPepper, 'WHATSAPP', lead.phoneE164), now),
    consentFor(ctx, 'EMAIL', keyOf(deps.contactKeyPepper, 'EMAIL', lead.emailNormalized), now),
    // The attributions Google returned with this place, while the finder still holds them (the 24 h purge removes them).
    lead.placeId === null ? Promise.resolve(null) : ctx.db.leadFinderResult.findFirst({ where: { placeId: lead.placeId, simulated: lead.simulated }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { attributions: true } }),
  ]);

  return {
    workspace,
    lead: {
      id: lead.id,
      displayName: lead.displayName,
      category: lead.category,
      phoneE164: lead.phoneE164,
      emailNormalized: lead.emailNormalized,
      website: lead.website,
      websiteStatus: lead.websiteStatus,
      address: lead.address,
      city: lead.city,
      ratingX10: lead.rating,
      reviewCount: lead.reviewCount,
      salesStage: lead.salesStage,
      stageVersion: lead.stageVersion,
      firstSource: lead.firstSource,
      simulated: lead.simulated,
      score: lead.score,
      createdAt: lead.createdAt.toISOString(),
      merged: lead.mergedIntoLeadId !== null,
    },
    score: {
      configVersion: scoreConfig?.version ?? null,
      reasons: asArray(lead.scoreReasons)
        .filter(isRecord)
        .map((r) => ({ input: String(r.input ?? ''), label: String(r.label ?? r.input ?? ''), points: num(r.points), maxPoints: num(r.maxPoints) })),
      unknownInputs: asArray(lead.unknownInputs)
        .filter(isRecord)
        .map((r) => ({ input: String(r.input ?? ''), label: String(r.label ?? r.input ?? ''), reasonCode: String(r.reasonCode ?? '') })),
    },
    consent: [whatsapp, email],
    sources: sources.map((s) => ({
      id: s.id,
      source: s.source,
      status: s.status,
      reasonCode: s.reasonCode,
      externalId: s.externalId,
      receivedAt: s.receivedAt.toISOString(),
      extractedAt: s.extractedAt?.toISOString() ?? null,
      mappingVersion: s.mappingVersion,
      attribution: attributionOf(s.attribution),
      batch: s.importBatch ? { externalBatchId: s.importBatch.externalBatchId, simulated: s.importBatch.simulated } : null,
    })),
    quotes: quotes.map((q) => ({
      id: q.id,
      number: q.number,
      status: effectiveQuoteStatus(q, now),
      currentVersionNo: q.currentVersionNo,
      totalPaise: q.currentVersion ? serializePaise(q.currentVersion.totalPaise) : null,
      validUntil: q.validUntil?.toISOString() ?? null,
    })),
    conversations: conversations.map((c) => ({ id: c.id, channel: c.channel, lastInboundProviderAt: c.lastInboundProviderAt?.toISOString() ?? null })),
    places:
      lead.placeId === null
        ? null
        : {
            expiresAt: lead.placesContentExpiresAt?.toISOString() ?? null,
            confirmedAt: lead.contactConfirmedAt?.toISOString() ?? null,
            confirmedVia: lead.contactConfirmedVia,
            attributions: placeResult && !lead.simulated ? attributionList(placeResult.attributions) : [],
            canConfirm: hasCapability(ctx, 'leads.write') && lead.mergedIntoLeadId === null,
          },
    permissions: { canMoveStage: hasCapability(ctx, 'leads.write') && lead.mergedIntoLeadId === null },
  };
}
