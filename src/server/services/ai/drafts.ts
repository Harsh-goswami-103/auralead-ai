/**
 * Lead draft generation (T14, R16, R17, C12, C13, ADR-18, ADR-55).
 *
 * One draft bundle per call: approved-template variable values, a follow-up text, an email
 * subject and body, and a structured quote proposal priced by the server.
 *
 * `generateLeadDraft(ctx, request, deps)` runs outside any transaction (it may call a provider):
 * 1. Load the lead's context from the workspace (./context-builder.ts) and build the prompt.
 * 2. Pick the generator (`selectWorkspaceAi`, ./run-task.ts): local in DEMO or for the explicit
 *    local action; in LIVE the workspace's AI integration, or nothing (AI_NOT_CONFIGURED). LIVE
 *    never switches to the local generator by itself.
 * 3. Call it (`runStructuredTask`, ./run-task.ts). A retryable provider failure (429, 5xx,
 *    timeout) is rethrown so the job retries, except on the job's final attempt, where it becomes a
 *    NEEDS_REVIEW draft. Auth failures, rejections and refusals go to NEEDS_REVIEW at once.
 * 4. Validate (./proposal.ts, as the task's evaluator). Malformed, empty or truncated output gets
 *    exactly one repair call carrying the validation issues (max tokens x1.5 after a truncation),
 *    then NEEDS_REVIEW.
 * 5. Price the surviving proposal items with `computeQuoteTotals` (server prices only).
 * The result is READY only with no flags, no policy violations, no review reasons and no error.
 *
 * `persistLeadDraft(tx, ctx, draft)` writes the AiDraft and its audit rows inside the caller's
 * transaction (the job's fenced settle, or the pipeline stage's finalTx).
 *
 * `requestLeadDraft(ctx, { leadId, local })` is the user action behind "Generate draft" and
 * "Generate with local template": it enqueues an `ai.draft` job (drafts.generate capability).
 */
import type { AiDraftTrigger, Prisma } from '@/generated/prisma/client';
import { AppError, PricingMissingError } from '@/lib/errors';
import { idempotencyKey } from '@/lib/ids';
import { serializePaise } from '@/lib/money';
import { redactText } from '@/lib/redact';
import type { GeneratorLabel } from '@/server/adapters/ai/port';
import type { AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import { assertSameWorkspace } from '@/server/db/scoped';
import { withTx } from '@/server/db/tx';
import { enqueueJob } from '@/server/jobs/queue';
import type { TxClient } from '@/server/jobs/types';
import { recordAudit } from '@/server/services/audit/record';
import { computeQuoteTotals, type ComputedQuote, type ReviewReason as PricingReviewReason } from '@/server/services/pricing/compute-totals';
import { buildDraftPrompt, loadDraftContext, type UntrustedInput } from './context-builder';
import { evaluateDraftOutput, type DraftEvaluation, type DraftReviewReason, type PolicyFlag, type ProposalItem } from './proposal';
import type { PolicyViolation } from './output-policy';
import { runStructuredTask, selectWorkspaceAi, type AiDeps } from './run-task';

export const AI_DRAFT_JOB = 'ai.draft';
export const AI_DRAFT_PAYLOAD_VERSION = 1;
export const DRAFT_MAX_TOKENS = 16_000;
const ERROR_TEXT_MAX = 500;

/** The AI dependencies (./run-task.ts): the credentials key ring and an optional transport override. */
export type DraftDeps = AiDeps;

export type DraftRequest = {
  leadId: string;
  trigger: AiDraftTrigger;
  /** userId, or `system:<jobType>`. */
  requestedBy: string;
  executionId?: string | null;
  untrusted?: UntrustedInput;
  /** True on the job's last attempt: a retryable provider failure is then stored as NEEDS_REVIEW. */
  finalAttempt: boolean;
};

export type DraftStatus = 'READY' | 'NEEDS_REVIEW';

export type GenerationReviewReason =
  | { code: 'GENERATION_FAILED'; errorCode: string; localGeneratorAvailable: boolean }
  | { code: 'AI_NOT_CONFIGURED' | 'MODE_MISMATCH'; localGeneratorAvailable: boolean }
  | { code: 'PRICING_MISSING' | 'TAX_NOT_CONFIGURED' };

export type AnyReviewReason = DraftReviewReason | GenerationReviewReason | PricingReviewReason;

export type PricingPreview = {
  pricingVersionId: string;
  pricingVersion: number;
  lines: Array<{ serviceId: string; serviceName: string; qty: number; unitPricePaise: string; lineTotalPaise: string }>;
  unpriced: Array<{ serviceId: string; serviceName: string; qty: number; reason: string }>;
  subtotalPaise: string;
  discountPaise: string;
  taxablePaise: string;
  taxPaise: string;
  totalPaise: string;
  taxLabel: string | null;
  taxBps: number | null;
};

export type GeneratedDraft = {
  leadId: string;
  executionId: string | null;
  trigger: AiDraftTrigger;
  status: DraftStatus;
  generatorLabel: GeneratorLabel | 'none';
  modelId: string | null;
  inputHash: string;
  templateVariables: { templateId: string | null; values: string[] };
  followUpText: string | null;
  emailSubject: string | null;
  emailBody: string | null;
  proposal: { items: ProposalItem[]; scopeText: string | null; timelineText: string | null } | null;
  pricingPreview: PricingPreview | null;
  aiPolicyFlags: PolicyFlag[];
  strippedKeys: string[];
  reviewReasons: AnyReviewReason[];
  policyViolations: PolicyViolation[];
  escalated: boolean;
  errorCode: string | null;
  errorRedacted: string | null;
  requestedBy: string;
  simulated: boolean;
};

function previewOf(q: ComputedQuote): PricingPreview {
  return {
    pricingVersionId: q.pricingVersion.id,
    pricingVersion: q.pricingVersion.version,
    lines: q.lines.map((l) => ({ serviceId: l.serviceId, serviceName: l.serviceName, qty: l.qty, unitPricePaise: serializePaise(l.unitPricePaise), lineTotalPaise: serializePaise(l.lineTotalPaise) })),
    unpriced: q.unpriced.map((u) => ({ serviceId: u.serviceId, serviceName: u.serviceName, qty: u.qty, reason: u.reason })),
    subtotalPaise: serializePaise(q.totals.subtotalPaise),
    discountPaise: serializePaise(q.totals.discountPaise),
    taxablePaise: serializePaise(q.totals.taxablePaise),
    taxPaise: serializePaise(q.totals.taxPaise),
    totalPaise: serializePaise(q.totals.totalPaise),
    taxLabel: q.tax.label,
    taxBps: q.tax.bps,
  };
}

export async function generateLeadDraft(ctx: AppCtx, request: DraftRequest, deps: DraftDeps): Promise<GeneratedDraft> {
  requireWorkspace(ctx);
  const context = await loadDraftContext(ctx, request.leadId, request.untrusted);
  const prompt = buildDraftPrompt(context.facts, context.untrusted);
  const forceLocal = request.trigger === 'LOCAL_EXPLICIT';

  const base = {
    leadId: context.lead.id,
    executionId: request.executionId ?? null,
    trigger: request.trigger,
    inputHash: prompt.inputHash,
    requestedBy: request.requestedBy,
    simulated: context.lead.simulated,
  };
  const empty = {
    templateVariables: { templateId: context.facts.template.templateId, values: [] as string[] },
    followUpText: null,
    emailSubject: null,
    emailBody: null,
    proposal: null,
    pricingPreview: null,
    aiPolicyFlags: [] as PolicyFlag[],
    strippedKeys: [] as string[],
    policyViolations: [] as PolicyViolation[],
    escalated: false,
  };

  const selection = await selectWorkspaceAi(ctx, deps, { forceLocal });
  if (!selection.ok) {
    return {
      ...base,
      ...empty,
      status: 'NEEDS_REVIEW',
      generatorLabel: selection.label,
      modelId: selection.modelId,
      reviewReasons: [{ code: selection.code, localGeneratorAvailable: selection.code === 'AI_NOT_CONFIGURED' }],
      errorCode: selection.errorCode,
      errorRedacted: null,
    };
  }
  const port = selection.port;

  const failed = (error: AppError): GeneratedDraft => ({
    ...base,
    ...empty,
    status: 'NEEDS_REVIEW',
    generatorLabel: port.label,
    modelId: port.modelId,
    reviewReasons: [{ code: 'GENERATION_FAILED', errorCode: error.code, localGeneratorAvailable: port.label !== 'local-deterministic' }],
    errorCode: error.code,
    errorRedacted: redactText(error.message).slice(0, ERROR_TEXT_MAX),
  });

  const run = await runStructuredTask<Extract<DraftEvaluation, { ok: true }>>({
    port,
    task: 'lead_draft',
    system: prompt.system,
    user: prompt.user,
    jsonSchema: prompt.jsonSchema,
    maxTokens: DRAFT_MAX_TOKENS,
    finalAttempt: request.finalAttempt,
    evaluate: (raw) => {
      const evaluation = evaluateDraftOutput(raw, { catalog: context.facts.catalog, policy: context.policy });
      return evaluation.ok ? { ok: true, value: evaluation } : { ok: false, issues: evaluation.issues };
    },
  });
  if (!run.ok) return failed(run.error);
  const evaluation = run.value;

  const reviewReasons: AnyReviewReason[] = [...evaluation.reviewReasons];
  let pricingPreview: PricingPreview | null = null;
  if (evaluation.draft.proposal.items.length > 0) {
    try {
      const priced = await computeQuoteTotals(ctx, { items: evaluation.draft.proposal.items, discount: { kind: 'NONE', value: 0n } });
      pricingPreview = previewOf(priced);
      reviewReasons.push(...priced.reviewReasons);
    } catch (error) {
      if (!(error instanceof PricingMissingError)) throw error;
      reviewReasons.push({ code: error.code === 'TAX_NOT_CONFIGURED' ? 'TAX_NOT_CONFIGURED' : 'PRICING_MISSING' });
    }
  }

  const status: DraftStatus = evaluation.flags.length === 0 && evaluation.violations.length === 0 && reviewReasons.length === 0 ? 'READY' : 'NEEDS_REVIEW';
  return {
    ...base,
    status,
    generatorLabel: port.label,
    modelId: port.modelId,
    templateVariables: { templateId: context.facts.template.templateId, values: evaluation.draft.templateVariables },
    followUpText: evaluation.draft.followUpText,
    emailSubject: evaluation.draft.emailSubject,
    emailBody: evaluation.draft.emailBody,
    proposal: evaluation.draft.proposal,
    pricingPreview,
    aiPolicyFlags: evaluation.flags,
    strippedKeys: evaluation.strippedKeys,
    reviewReasons,
    policyViolations: evaluation.violations,
    escalated: evaluation.escalated,
    errorCode: null,
    errorRedacted: null,
  };
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

/** Writes the AiDraft and its audit rows in the caller's transaction (raw or scoped client). */
export async function persistLeadDraft(tx: TxClient, ctx: AppCtx, draft: GeneratedDraft): Promise<{ id: string }> {
  const workspaceId = requireWorkspace(ctx);
  const row = await tx.aiDraft.create({
    data: {
      workspaceId,
      leadId: draft.leadId,
      executionId: draft.executionId,
      trigger: draft.trigger,
      status: draft.status,
      generatorLabel: draft.generatorLabel,
      modelId: draft.modelId,
      inputHash: draft.inputHash,
      templateVariables: json(draft.templateVariables),
      followUpText: draft.followUpText,
      emailSubject: draft.emailSubject,
      emailBody: draft.emailBody,
      proposal: draft.proposal === null ? undefined : json(draft.proposal),
      pricingPreview: draft.pricingPreview === null ? undefined : json(draft.pricingPreview),
      aiPolicyFlags: json(draft.aiPolicyFlags),
      reviewReasons: json(draft.reviewReasons),
      policyViolations: json(draft.policyViolations),
      escalated: draft.escalated,
      errorCode: draft.errorCode,
      errorRedacted: draft.errorRedacted,
      requestedBy: draft.requestedBy,
      correlationId: ctx.correlationId,
      createdAt: ctx.clock.now(),
    },
    select: { id: true },
  });

  await recordAudit(tx, ctx, {
    action: 'ai.draft.generate',
    targetType: 'AiDraft',
    targetId: row.id,
    simulated: draft.simulated,
    summary: {
      leadId: draft.leadId,
      executionId: draft.executionId,
      trigger: draft.trigger,
      status: draft.status,
      generatorLabel: draft.generatorLabel,
      modelId: draft.modelId,
      flags: draft.aiPolicyFlags,
      reviewReasonCodes: draft.reviewReasons.map((r) => r.code),
      violationRules: draft.policyViolations.map((v) => `${v.field}:${v.rule}`),
      escalated: draft.escalated,
      errorCode: draft.errorCode,
    },
  });
  if (draft.aiPolicyFlags.length > 0) {
    await recordAudit(tx, ctx, {
      action: 'ai.proposal.flagged',
      targetType: 'AiDraft',
      targetId: row.id,
      simulated: draft.simulated,
      summary: { leadId: draft.leadId, flags: draft.aiPolicyFlags, strippedKeys: draft.strippedKeys, generatorLabel: draft.generatorLabel },
    });
  }
  return row;
}

/**
 * "Generate draft" (`local: false`) and "Generate with local template" (`local: true`, C13):
 * enqueues one `ai.draft` job for a lead of the caller's workspace. Needs drafts.generate.
 */
export async function requestLeadDraft(ctx: AppCtx, input: { leadId: string; local: boolean }): Promise<{ jobId: string; trigger: AiDraftTrigger }> {
  requireCapability(ctx, 'drafts.generate');
  const workspaceId = requireWorkspace(ctx);
  const trigger: AiDraftTrigger = input.local ? 'LOCAL_EXPLICIT' : 'MANUAL';
  const requestedBy = ctx.actor?.userId ?? `system:${ctx.kind}`;
  return withTx(ctx.db, async (scoped) => {
    // The scoped client keeps every write inside the caller's workspace; typed as a plain tx client.
    const tx = scoped as unknown as TxClient;
    await assertSameWorkspace(tx, ctx, { leadId: input.leadId });
    const { job } = await enqueueJob(tx, ctx.clock, {
      type: AI_DRAFT_JOB,
      payload: { leadId: input.leadId, trigger, requestedBy },
      payloadVersion: AI_DRAFT_PAYLOAD_VERSION,
      workspaceId,
      idempotencyKey: idempotencyKey(AI_DRAFT_JOB, input.leadId, trigger, ctx.correlationId),
      correlationId: ctx.correlationId,
      causationId: ctx.causationId ?? null,
      kind: 'ai',
    });
    await recordAudit(tx, ctx, { action: 'ai.draft.request', targetType: 'Lead', targetId: input.leadId, summary: { trigger, jobId: job.id } });
    return { jobId: job.id, trigger };
  });
}
