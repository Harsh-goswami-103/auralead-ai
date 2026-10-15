/**
 * APPROVAL stage (T23; E9, O5, P11, ADR-27, ADR-43). The mandatory approval node between the AI
 * draft and any customer contact. It decides how the execution's first-touch draft (the DRAFT
 * stage's AiDraft) reaches the lead, under the approval mode of the lead's pinned
 * PipelineConfigVersion:
 *
 * - The sendable options come from the draft: a WhatsApp template message (the draft carries an
 *   approved FIRST_TOUCH template and the lead a phone), then an email (subject, body and address).
 *   Each option is checked with the shared dispatch eligibility function for the intent it would be
 *   sent with (MANUAL_SINGLE after a person approves, AUTOMATED under POLICY_AUTO); the first one
 *   that is eligible, or only deferred, is chosen, else the first option.
 * - POLICY_AUTO approves by policy only when workspace auto-send is on now, the draft is READY and
 *   carries no AI policy flag, violation or escalation, and the chosen option may be sent
 *   automatically. The decision is recorded (`POLICY_APPROVED`, audited); the DELIVERY stage then
 *   queues the AUTOMATED send, and dispatch re-checks everything at send time (E4).
 * - Otherwise (HUMAN, or a policy blocker) the stage creates the review item: a DRAFT outbound
 *   Message with a PENDING OUTBOUND_MESSAGE approval (`HUMAN_REVIEW`). A person approves and sends it
 *   from the approval queue (MANUAL_SINGLE); nothing is sent automatically, and activating a
 *   POLICY_AUTO version later never touches it (O5).
 * - No sendable option at all (no approved template synced and no email draft or address):
 *   SKIPPED `NO_SENDABLE_DRAFT` with what is missing per channel; no draft at all: SKIPPED
 *   `NO_DRAFT`.
 *
 * `run` only reads; every write (message, approval, audit, the stage run's ids) happens in
 * `finalTx`, inside the job's fenced settle, so a replay or restart commits the decision once.
 */
import type { AiDraft, Channel, Prisma } from '@/generated/prisma/client';
import { getConfig } from '@/lib/config';
import type { AppCtx } from '@/server/auth/context';
import { scopeArgs, TENANT_MODELS, type ScopedTx } from '@/server/db/scoped';
import type { TxClient } from '@/server/jobs/types';
import { destinationKeyFor } from '@/server/services/approvals/payload-hash';
import { recordAudit } from '@/server/services/audit/record';
import { checkDispatchEligibility, POLICY_AUTO_INITIATOR, type DispatchKind, type EligibilityResult } from '@/server/services/messaging/eligibility';
import type { StageHandler } from './types';

export type PipelineStageDeps = { contactKeyPepper: string };

export function pipelineStageDepsFromConfig(): PipelineStageDeps {
  const pepper = getConfig().secrets.suppressionPepper;
  if (!pepper) throw new Error('SUPPRESSION_PEPPER is required for the approval and delivery stages (run npm run setup)');
  return { contactKeyPepper: pepper };
}

export type ApprovalDecision = 'POLICY_APPROVED' | 'HUMAN_REVIEW';
export type PolicyBlocker = 'AUTO_SEND_DISABLED' | 'DRAFT_NEEDS_REVIEW' | 'DRAFT_FLAGGED' | 'NOT_ELIGIBLE';

/** Approval flag marking a review item the pipeline created. */
export const PIPELINE_APPROVAL_FLAG = 'pipeline_first_touch';

/**
 * A raw transaction client scoped to one workspace, like `ctx.db` inside `withTx`: every tenant
 * model operation gets `workspaceId` injected and checked (`scopeArgs`). Used inside a job's fenced
 * settle (which hands out the raw client) to call services written for a scoped transaction.
 */
export function scopeTransaction(tx: TxClient, workspaceId: string): ScopedTx {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || value === null || typeof value !== 'object') return value;
      const model = prop.charAt(0).toUpperCase() + prop.slice(1);
      if (!TENANT_MODELS.has(model as Prisma.ModelName)) return value;
      return new Proxy(value, {
        get(delegate, op, r) {
          const fn: unknown = Reflect.get(delegate, op, r);
          if (typeof op !== 'string' || typeof fn !== 'function') return fn;
          return (args?: unknown) => (fn as (a: unknown) => unknown).call(delegate, scopeArgs(model, op, args, workspaceId));
        },
      });
    },
  }) as unknown as ScopedTx;
}

export type FirstTouch = {
  channel: Channel;
  dispatchKind: DispatchKind;
  kind: 'TEMPLATE' | 'EMAIL';
  templateId: string | null;
  variables: Record<string, string> | null;
  subject: string | null;
  body: string | null;
};

type TemplateRef = { templateId: string | null; values: string[] };

function templateRef(value: Prisma.JsonValue): TemplateRef {
  const raw = (value ?? {}) as { templateId?: unknown; values?: unknown };
  return {
    templateId: typeof raw.templateId === 'string' && raw.templateId.length > 0 ? raw.templateId : null,
    values: Array.isArray(raw.values) ? raw.values.filter((v): v is string => typeof v === 'string') : [],
  };
}

/** The draft's first-touch content for one channel, or why that channel has none. */
export function firstTouchFor(
  channel: Channel,
  draft: Pick<AiDraft, 'templateVariables' | 'emailSubject' | 'emailBody'>,
  lead: { phoneE164: string | null; emailNormalized: string | null },
  template: { id: string } | null,
): { ok: true; touch: FirstTouch } | { ok: false; missing: string } {
  if (channel === 'WHATSAPP') {
    if (lead.phoneE164 === null) return { ok: false, missing: 'NO_PHONE' };
    const ref = templateRef(draft.templateVariables);
    if (ref.templateId === null || template === null || template.id !== ref.templateId) return { ok: false, missing: 'NO_APPROVED_TEMPLATE' };
    const variables = Object.fromEntries(ref.values.map((v, i) => [String(i + 1), v]));
    return { ok: true, touch: { channel, dispatchKind: 'WA_TEMPLATE', kind: 'TEMPLATE', templateId: ref.templateId, variables, subject: null, body: null } };
  }
  if (lead.emailNormalized === null) return { ok: false, missing: 'NO_EMAIL_ADDRESS' };
  if (!draft.emailSubject?.trim() || !draft.emailBody?.trim()) return { ok: false, missing: 'NO_EMAIL_DRAFT' };
  return { ok: true, touch: { channel, dispatchKind: 'EMAIL', kind: 'EMAIL', templateId: null, variables: null, subject: draft.emailSubject, body: draft.emailBody } };
}

/** The draft's template row when it still exists in the workspace. */
export async function draftTemplate(ctx: AppCtx, draft: Pick<AiDraft, 'templateVariables'>): Promise<{ id: string } | null> {
  const ref = templateRef(draft.templateVariables);
  if (ref.templateId === null) return null;
  return ctx.db.whatsAppTemplate.findFirst({ where: { id: ref.templateId }, select: { id: true } });
}

function stringList(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

const usable = (r: EligibilityResult) => r.eligible || r.deferrable;

export function createApprovalStage(deps: () => PipelineStageDeps = pipelineStageDepsFromConfig): StageHandler {
  return {
    stage: 'APPROVAL',
    async run({ ctx, execution, lead, config }) {
      const draft = await ctx.db.aiDraft.findFirst({ where: { executionId: execution.id } });
      if (!draft) return { status: 'SKIPPED', reasonCode: 'NO_DRAFT' };

      const template = await draftTemplate(ctx, draft);
      const options: FirstTouch[] = [];
      const missing: Record<string, string> = {};
      for (const channel of ['WHATSAPP', 'EMAIL'] as const) {
        const found = firstTouchFor(channel, draft, lead, template);
        if (found.ok) options.push(found.touch);
        else missing[channel] = found.missing;
      }
      if (options.length === 0) return { status: 'SKIPPED', reasonCode: 'NO_SENDABLE_DRAFT', outputRef: { draftId: draft.id, missing } };

      const policy = config.approvalMode === 'POLICY_AUTO';
      const sendIntent = policy ? 'AUTOMATED' : 'MANUAL_SINGLE';
      const { contactKeyPepper } = deps();
      const checks: EligibilityResult[] = [];
      for (const option of options) {
        checks.push(
          await checkDispatchEligibility(
            ctx.db,
            ctx,
            { leadId: lead.id, channel: option.channel, kind: option.dispatchKind, sendIntent, templateId: option.templateId, initiatedBy: policy ? POLICY_AUTO_INITIATOR : null },
            { contactKeyPepper },
          ),
        );
      }
      const index = Math.max(0, checks.findIndex(usable));
      const chosen = options[index]!;
      const check = checks[index]!;
      const base = { draftId: draft.id, approvalMode: config.approvalMode, channel: chosen.channel, kind: chosen.kind, templateId: chosen.templateId, reasons: check.reasons, missing };

      const blockers: PolicyBlocker[] = [];
      if (policy) {
        const settings = await ctx.db.workspaceSettings.findFirst({ select: { autoSendEnabled: true } });
        if (!(settings?.autoSendEnabled ?? false)) blockers.push('AUTO_SEND_DISABLED');
        if (draft.status !== 'READY') blockers.push('DRAFT_NEEDS_REVIEW');
        if (draft.escalated || stringList(draft.aiPolicyFlags).length > 0 || (Array.isArray(draft.policyViolations) && draft.policyViolations.length > 0)) blockers.push('DRAFT_FLAGGED');
        if (!usable(check)) blockers.push('NOT_ELIGIBLE');
        if (blockers.length === 0) {
          return {
            status: 'DONE',
            outputRef: { ...base, decision: 'POLICY_APPROVED' satisfies ApprovalDecision, deferred: !check.eligible },
            finalTx: async (tx) => {
              await recordAudit(scopeTransaction(tx, execution.workspaceId), ctx, {
                action: 'pipeline.approval.policy',
                targetType: 'PipelineExecution',
                targetId: execution.id,
                simulated: lead.simulated,
                summary: { leadId: lead.id, draftId: draft.id, channel: chosen.channel, approvalMode: 'POLICY_AUTO', deferredBy: check.reasons },
              });
            },
          };
        }
      }

      const outputRef = { ...base, decision: 'HUMAN_REVIEW' satisfies ApprovalDecision, blockers };
      return {
        status: 'DONE',
        outputRef,
        finalTx: async (raw) => {
          const tx = scopeTransaction(raw, execution.workspaceId);
          const now = ctx.clock.now();
          const contactKey = destinationKeyFor(contactKeyPepper, chosen.channel, lead);
          if (contactKey === null) throw new Error(`lead ${lead.id} has no usable ${chosen.channel} contact`);
          const conversation =
            (await tx.conversation.findFirst({ where: { leadId: lead.id, channel: chosen.channel, closedAt: null }, select: { id: true } })) ??
            (await tx.conversation.create({ data: { workspaceId: execution.workspaceId, leadId: lead.id, channel: chosen.channel, contactKey, createdAt: now }, select: { id: true } }));
          const message = await tx.message.create({
            data: {
              workspaceId: execution.workspaceId,
              conversationId: conversation.id,
              direction: 'OUT',
              channel: chosen.channel,
              kind: chosen.kind,
              body: chosen.body,
              subject: chosen.subject,
              templateId: chosen.templateId,
              variables: chosen.variables ?? undefined,
              status: 'DRAFT',
              statusRank: 0,
              simulated: ctx.mode === 'demo',
              generatorLabel: draft.generatorLabel,
              sendIntent: null,
              initiatedBy: null,
              createdBy: null,
              createdAt: now,
            },
            select: { id: true },
          });
          const flags = [PIPELINE_APPROVAL_FLAG, ...stringList(draft.aiPolicyFlags), ...blockers.map((b) => `policy_auto_blocked:${b}`)];
          const approval = await tx.approval.create({
            data: { workspaceId: execution.workspaceId, kind: 'OUTBOUND_MESSAGE', status: 'PENDING', messageId: message.id, flags, requestedAt: now },
            select: { id: true },
          });
          await recordAudit(tx, ctx, {
            action: 'pipeline.approval.requested',
            targetType: 'Approval',
            targetId: approval.id,
            simulated: lead.simulated,
            summary: { executionId: execution.id, leadId: lead.id, messageId: message.id, channel: chosen.channel, approvalMode: config.approvalMode, blockers, reasons: check.reasons },
          });
          await tx.pipelineStageRun.update({
            where: { executionId_stage: { executionId: execution.id, stage: 'APPROVAL' } },
            data: { outputRef: { ...outputRef, approvalId: approval.id, messageId: message.id, conversationId: conversation.id } },
          });
        },
      };
    },
  };
}

export const approvalStage = createApprovalStage();
