/**
 * Employee lead console, lead part (T17, R32 console, plan §11 M2). Reads and actions for one
 * lead of the caller's workspace, all through the tenant-scoped context:
 *  - `loadLeadDetail`: the lead, its score breakdown, pinned pipeline progress, recent AI drafts,
 *    its quotations (effective status, current total, whether the current version's PDF exists)
 *    and the caller's permissions for the console buttons;
 *  - `createQuoteFromProposal`: "Create quote from proposal". The proposal only names catalog
 *    services and quantities (C12); `createQuote` prices them from the server price list;
 *  - `approveLeadQuote` and `getLeadQuotePdf`: the quote service and the stored-PDF reader, after
 *    checking that the quote belongs to this lead (a quote of another lead is 404).
 */
import type { AiDraftStatus, AiDraftTrigger, LeadSource, PipelineStage, PrismaClient, QuoteStatus, SalesStage, StageRunStatus, WebsiteStatus } from '@/generated/prisma/client';
import { DomainRuleError, NotFoundError } from '@/lib/errors';
import { serializePaise } from '@/lib/money';
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireCapability, requireWorkspace } from '@/server/auth/guards';
import { getWorkspaceQuotePdf, type PdfResult } from '@/server/pdf/serve';
import { approveQuote, createQuote, effectiveQuoteStatus, type QuoteWriteResult } from '@/server/services/quotes/versioning';

const STAGE_ORDER: readonly PipelineStage[] = ['INGESTION', 'SCORE', 'DRAFT', 'APPROVAL', 'DELIVERY'];
const DRAFT_LIMIT = 5;

export type ScoreReasonView = { input: string; label: string; points: number; maxPoints: number };
export type UnknownInputView = { input: string; label: string; reasonCode: string };

export type DraftView = {
  id: string;
  trigger: AiDraftTrigger;
  status: AiDraftStatus;
  generatorLabel: string;
  createdAt: Date;
  followUpText: string | null;
  emailSubject: string | null;
  emailBody: string | null;
  hasProposal: boolean;
  proposalLines: Array<{ serviceId: string; serviceName: string; qty: number; lineTotalPaise: string | null }>;
  scopeText: string | null;
  timelineText: string | null;
  previewTotalPaise: string | null;
  reviewReasons: string[];
  aiPolicyFlags: string[];
  /** The latest generation could not use a provider and the local template can be run explicitly (C13). */
  localGeneratorAvailable: boolean;
};

export type LeadQuoteView = {
  id: string;
  number: string;
  status: QuoteStatus;
  currentVersionNo: number;
  totalPaise: string | null;
  needsPricingReview: boolean;
  validUntil: Date | null;
  validityPassed: boolean;
  pdfReady: boolean;
  createdAt: Date;
};

export type LeadDetail = {
  workspace: { id: string; slug: string; name: string; timezone: string };
  lead: {
    id: string;
    displayName: string;
    category: string | null;
    phoneE164: string | null;
    emailNormalized: string | null;
    website: string | null;
    websiteStatus: WebsiteStatus;
    address: string | null;
    city: string | null;
    ratingX10: number | null;
    reviewCount: number | null;
    salesStage: SalesStage;
    firstSource: LeadSource;
    simulated: boolean;
    score: number | null;
    createdAt: Date;
  };
  score: { configVersion: number | null; reasons: ScoreReasonView[]; unknownInputs: UnknownInputView[] };
  pipeline: Array<{ stage: PipelineStage; status: StageRunStatus; reasonCode: string | null; finishedAt: Date | null }>;
  drafts: DraftView[];
  quotes: LeadQuoteView[];
  permissions: { canGenerateDraft: boolean; canCreateQuote: boolean; canApprove: boolean };
};

type JsonRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is JsonRecord => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function reasonsOf(value: unknown): ScoreReasonView[] {
  return asArray(value)
    .filter(isRecord)
    .map((r) => ({ input: String(r.input ?? ''), label: String(r.label ?? r.input ?? ''), points: num(r.points), maxPoints: num(r.maxPoints) }));
}

function unknownsOf(value: unknown): UnknownInputView[] {
  return asArray(value)
    .filter(isRecord)
    .map((r) => ({ input: String(r.input ?? ''), label: String(r.label ?? r.input ?? ''), reasonCode: String(r.reasonCode ?? '') }));
}

type DraftRow = {
  id: string;
  trigger: AiDraftTrigger;
  status: AiDraftStatus;
  generatorLabel: string;
  createdAt: Date;
  followUpText: string | null;
  emailSubject: string | null;
  emailBody: string | null;
  proposal: unknown;
  pricingPreview: unknown;
  reviewReasons: unknown;
  aiPolicyFlags: unknown;
};

function draftView(row: DraftRow, serviceNames: ReadonlyMap<string, string>): DraftView {
  const proposal = isRecord(row.proposal) ? row.proposal : null;
  const items = asArray(proposal?.items).filter(isRecord);
  const preview = isRecord(row.pricingPreview) ? row.pricingPreview : null;
  const previewLines = new Map(asArray(preview?.lines).filter(isRecord).map((l) => [String(l.serviceId), l]));
  const reasons = asArray(row.reviewReasons).filter(isRecord);
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    generatorLabel: row.generatorLabel,
    createdAt: row.createdAt,
    followUpText: row.followUpText,
    emailSubject: row.emailSubject,
    emailBody: row.emailBody,
    hasProposal: items.length > 0,
    proposalLines: items.map((i) => {
      const serviceId = String(i.serviceId);
      const line = previewLines.get(serviceId);
      return { serviceId, serviceName: str(line?.serviceName) ?? serviceNames.get(serviceId) ?? serviceId, qty: num(i.qty), lineTotalPaise: str(line?.lineTotalPaise) };
    }),
    scopeText: str(proposal?.scopeText),
    timelineText: str(proposal?.timelineText),
    previewTotalPaise: str(preview?.totalPaise),
    reviewReasons: reasons.map((r) => String(r.code)),
    aiPolicyFlags: asArray(row.aiPolicyFlags).filter((f): f is string => typeof f === 'string'),
    localGeneratorAvailable: reasons.some((r) => (r.code === 'AI_NOT_CONFIGURED' || r.code === 'GENERATION_FAILED') && r.localGeneratorAvailable === true),
  };
}

async function findLead(ctx: AppCtx, leadId: string) {
  const lead = await ctx.db.lead.findFirst({ where: { id: leadId } });
  if (!lead) throw new NotFoundError();
  return lead;
}

export async function loadLeadDetail(ctx: AppCtx, leadId: string): Promise<LeadDetail> {
  requireCapability(ctx, 'leads.read');
  const workspaceId = requireWorkspace(ctx);
  const lead = await findLead(ctx, leadId);
  const now = ctx.clock.now();

  const [workspace, scoreConfig, execution, drafts, quotes, services] = await Promise.all([
    ctx.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { id: true, slug: true, name: true, timezone: true } }),
    lead.scoreConfigVersionId ? ctx.db.scoringConfigVersion.findFirst({ where: { id: lead.scoreConfigVersionId }, select: { version: true } }) : Promise.resolve(null),
    ctx.db.pipelineExecution.findFirst({ where: { leadId }, include: { stageRuns: true } }),
    ctx.db.aiDraft.findMany({ where: { leadId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: DRAFT_LIMIT }),
    ctx.db.quote.findMany({ where: { leadId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: { currentVersion: { select: { id: true, totalPaise: true } } } }),
    ctx.db.service.findMany({ select: { id: true, name: true } }),
  ]);
  const versionIds = quotes.map((q) => q.currentVersion?.id).filter((id): id is string => typeof id === 'string');
  const artifacts = versionIds.length === 0 ? [] : await ctx.db.quoteArtifact.findMany({ where: { quoteVersionId: { in: versionIds } }, select: { quoteVersionId: true } });
  const rendered = new Set(artifacts.map((a) => a.quoteVersionId));
  const serviceNames = new Map(services.map((s) => [s.id, s.name]));

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
      firstSource: lead.firstSource,
      simulated: lead.simulated,
      score: lead.score,
      createdAt: lead.createdAt,
    },
    score: { configVersion: scoreConfig?.version ?? null, reasons: reasonsOf(lead.scoreReasons), unknownInputs: unknownsOf(lead.unknownInputs) },
    pipeline: (execution?.stageRuns ?? [])
      .slice()
      .sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage))
      .map((r) => ({ stage: r.stage, status: r.status, reasonCode: r.reasonCode, finishedAt: r.finishedAt })),
    drafts: drafts.map((d) => draftView(d, serviceNames)),
    quotes: quotes.map((q) => {
      const status = effectiveQuoteStatus(q, now);
      return {
        id: q.id,
        number: q.number,
        status,
        currentVersionNo: q.currentVersionNo,
        totalPaise: q.currentVersion ? serializePaise(q.currentVersion.totalPaise) : null,
        needsPricingReview: q.needsPricingReview,
        validUntil: q.validUntil,
        validityPassed: q.validUntil !== null && now.getTime() >= q.validUntil.getTime(),
        pdfReady: q.currentVersion ? rendered.has(q.currentVersion.id) : false,
        createdAt: q.createdAt,
      };
    }),
    permissions: {
      canGenerateDraft: hasCapability(ctx, 'drafts.generate'),
      canCreateQuote: hasCapability(ctx, 'quotes.edit'),
      canApprove: hasCapability(ctx, 'approvals.decide'),
    },
  };
}

/**
 * "Create quote from proposal": a DRAFT v1 quote for the lead with exactly the services and
 * quantities the draft proposed, the draft's scope and timeline text, no discount, priced by the
 * server. A proposal without services, or whose text failed the output policy, is refused (422)
 * rather than filled in.
 */
export async function createQuoteFromProposal(ctx: AppCtx, input: { leadId: string; draftId: string }): Promise<QuoteWriteResult> {
  requireCapability(ctx, 'quotes.edit');
  requireWorkspace(ctx);
  await findLead(ctx, input.leadId);
  const draft = await ctx.db.aiDraft.findFirst({ where: { id: input.draftId, leadId: input.leadId }, select: { id: true, proposal: true } });
  if (!draft) throw new NotFoundError({ message: 'draft not found for this lead' });
  const proposal = isRecord(draft.proposal) ? draft.proposal : null;
  const items = asArray(proposal?.items)
    .filter(isRecord)
    .map((i) => ({ serviceId: String(i.serviceId), qty: num(i.qty) }));
  if (items.length === 0) {
    throw new DomainRuleError({ code: 'PROPOSAL_EMPTY', userMessage: 'This draft does not propose any catalog service. Generate a new draft before creating a quote.', safeDetails: { draftId: draft.id } });
  }
  const scopeText = str(proposal?.scopeText)?.trim() ?? '';
  const timelineText = str(proposal?.timelineText)?.trim() ?? '';
  if (scopeText.length === 0 || timelineText.length === 0) {
    throw new DomainRuleError({
      code: 'PROPOSAL_INCOMPLETE',
      userMessage: 'This draft has no usable scope or timeline text. Generate a new draft before creating a quote.',
      safeDetails: { draftId: draft.id, scope: scopeText.length > 0, timeline: timelineText.length > 0 },
    });
  }
  return createQuote(ctx, { leadId: input.leadId, draftId: draft.id, items, discount: { kind: 'NONE', value: 0n }, scopeText, timelineText });
}

async function assertQuoteOfLead(ctx: AppCtx, leadId: string, quoteId: string): Promise<void> {
  const quote = await ctx.db.quote.findFirst({ where: { id: quoteId, leadId }, select: { id: true } });
  if (!quote) throw new NotFoundError();
}

export async function approveLeadQuote(ctx: AppCtx, input: { leadId: string; quoteId: string; expectedVersion: number }) {
  requireCapability(ctx, 'approvals.decide');
  requireWorkspace(ctx);
  await assertQuoteOfLead(ctx, input.leadId, input.quoteId);
  return approveQuote(ctx, input.quoteId, { expectedVersion: input.expectedVersion });
}

export async function getLeadQuotePdf(ctx: AppCtx, db: PrismaClient, input: { leadId: string; quoteId: string; versionNo?: number; storageDir: string }): Promise<PdfResult> {
  requireCapability(ctx, 'leads.read');
  requireWorkspace(ctx);
  await assertQuoteOfLead(ctx, input.leadId, input.quoteId);
  return getWorkspaceQuotePdf(ctx, db, { quoteId: input.quoteId, versionNo: input.versionNo, storageDir: input.storageDir });
}
