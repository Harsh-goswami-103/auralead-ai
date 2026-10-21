/**
 * Campaign pause and resume (T35; PRD "pause/resume with confirmation ... demo toggles simulated
 * only"; plan §4.4 outbox rule for CampaignAction; AT14; R44).
 *
 * Request (`requestCampaignStatusChange`, `campaigns.control`, typed confirmation PAUSE or RESUME,
 * a client request key so a double click or a retry is one action):
 *  - DEMO: the campaign (simulated) changes status in one transaction with a CampaignAction in
 *    state SIMULATED and its audit row, labelled Simulated. No adapter, zero outbound traffic.
 *  - LIVE without a verified integration (CONNECTED or DEGRADED with `verifiedAt`): 412
 *    INTEGRATION_NOT_VERIFIED, audited DENIED; nothing is queued and the adapter is never called.
 *  - LIVE verified: a CampaignAction PENDING plus one `campaign.action` job, audited. One action
 *    in flight per campaign (409); a change to the status the campaign already has is 409.
 *
 * Run (`runCampaignAction`, the job): the integration is checked again (not verified: FAILED,
 * adapter not called); a fenced transaction moves the action PENDING -> SENDING before the
 * provider call; `POST /<campaign id>` with the status runs outside any transaction; the settle is
 * the job's fenced finalTx:
 *  - `success: true`: the status is read back (`GET /<campaign id>?fields=...effective_status`);
 *    SUCCEEDED with the read-back effective status stored on the action and the campaign. If the
 *    read-back itself fails, the action is SUCCEEDED, the campaign's configured status is the
 *    target Meta confirmed, and a `campaign.readback` job refreshes the effective status;
 *  - a timeout or reset after the request was written, a 5xx, or a 2xx without `success: true`:
 *    UNKNOWN ("Confirming with Meta"), and a `campaign.readback` job resolves it from provider
 *    truth: the target status seen -> SUCCEEDED, any other -> FAILED (the change did not apply);
 *  - a definite refusal (token, permission named, unknown campaign, rejected): FAILED with the
 *    reason, the campaign's status unchanged, never shown as success;
 *  - throttling or a failure before the write: back to PENDING and retried with backoff; FAILED at
 *    the last attempt.
 * A job that finds its action already SENDING (a worker died during the call) never calls Meta
 * again: the action becomes UNKNOWN and is read back. Every outcome is audited.
 */
import type { CampaignAction } from '@/generated/prisma/client';
import { ConflictError, DomainRuleError, IntegrationNotVerifiedError, NotFoundError } from '@/lib/errors';
import { redactText } from '@/lib/redact';
import { CAMPAIGN_CONFIRM_TEXT, type CampaignTargetStatus } from '@/lib/schemas/meta';
import { classifyMetaFailure, parseCampaignStatus, type MetaMarketingClient } from '@/server/adapters/meta/graph';
import { CHECKABLE_STATUSES, metaMarketingClient, SEND_USABLE_STATUSES } from '@/server/adapters/registry';
import { getJobContext, type AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import { LeaseLostError } from '@/server/db/fence';
import { withTx } from '@/server/db/tx';
import { enqueueJob } from '@/server/jobs/queue';
import type { FinalTx, JobHandlerContext, JobResult, TxClient } from '@/server/jobs/types';
import { recordAudit } from '@/server/services/audit/record';
import { loadIntegrationForUse } from '@/server/services/integrations/credentials';
import type { LiveAdapterDeps } from '@/server/services/integrations/live-testers';
import { CAMPAIGN_ACTION_JOB, CAMPAIGN_READBACK_DELAY_MS, CAMPAIGN_READBACK_JOB, META_JOB_PAYLOAD_VERSION, metaBackoffMs } from './constants';
import { recordMetaAccessProblem } from './integration-problems';

const MAX_RESULT = 500;
const IN_FLIGHT = ['PENDING', 'SENDING', 'UNKNOWN'] as const;

export type CampaignActionView = {
  id: string;
  campaignId: string;
  targetStatus: string;
  state: CampaignAction['state'];
  previousStatus: string | null;
  reasonCode: string | null;
  message: string | null;
  readBackStatus: string | null;
  readBackAt: Date | null;
  createdAt: Date;
  resolvedAt: Date | null;
};

export function actionView(a: CampaignAction): CampaignActionView {
  return {
    id: a.id,
    campaignId: a.campaignId,
    targetStatus: a.targetStatus,
    state: a.state,
    previousStatus: a.previousStatus,
    reasonCode: a.reasonCode,
    message: a.providerResultRedacted,
    readBackStatus: a.readBackStatus,
    readBackAt: a.readBackAt,
    createdAt: a.createdAt,
    resolvedAt: a.resolvedAt,
  };
}

export function actionKey(campaignId: string, requestKey: string): string {
  return `campaign-action:${campaignId}:${requestKey}`;
}

export function actionJobKey(actionId: string): string {
  return `${CAMPAIGN_ACTION_JOB}:${actionId}`;
}

const bounded = (text: string) => redactText(text).slice(0, MAX_RESULT);

/** Verified = CONNECTED or DEGRADED with a stored verification time (a live test passed). */
export function isVerified(integration: { status: string; verifiedAt: Date | null } | null): boolean {
  return integration !== null && SEND_USABLE_STATUSES.has(integration.status as never) && integration.verifiedAt !== null;
}

export async function requestCampaignStatusChange(
  ctx: AppCtx,
  input: { campaignId: string; targetStatus: CampaignTargetStatus; confirm: string; requestKey: string },
): Promise<CampaignActionView & { created: boolean; simulated: boolean }> {
  requireCapability(ctx, 'campaigns.control');
  const workspaceId = requireWorkspace(ctx);
  const ws = await ctx.db.workspace.findUnique({ where: { id: workspaceId }, select: { mode: true } });
  if (!ws || ws.mode !== (ctx.mode === 'demo' ? 'DEMO' : 'LIVE')) throw new NotFoundError();
  const campaign = await ctx.db.campaign.findFirst({ where: { id: input.campaignId } });
  if (!campaign || campaign.simulated !== (ctx.mode === 'demo')) throw new NotFoundError({ message: 'no such campaign in this workspace and mode' });
  const expected = CAMPAIGN_CONFIRM_TEXT[input.targetStatus];
  if (input.confirm.trim().toUpperCase() !== expected) {
    throw new DomainRuleError({ code: 'CONFIRMATION_REQUIRED', userMessage: `Type ${expected} to confirm.` });
  }
  const key = actionKey(campaign.id, input.requestKey);
  const existing = await ctx.db.campaignAction.findFirst({ where: { idempotencyKey: key } });
  if (existing) return { ...actionView(existing), created: false, simulated: existing.state === 'SIMULATED' };
  if (campaign.configuredStatus.toUpperCase() === input.targetStatus) {
    throw new ConflictError({ code: 'CAMPAIGN_STATUS_UNCHANGED', userMessage: `The campaign is already ${input.targetStatus === 'PAUSED' ? 'paused' : 'active'}. Sync campaigns if Ads Manager shows something else.` });
  }
  const inFlight = await ctx.db.campaignAction.findFirst({ where: { campaignId: campaign.id, state: { in: [...IN_FLIGHT] } }, select: { id: true } });
  if (inFlight) throw new ConflictError({ code: 'CAMPAIGN_ACTION_IN_FLIGHT', userMessage: 'A change to this campaign is still being confirmed with Meta. Wait for its result first.' });
  const now = ctx.clock.now();
  const actor = ctx.actor?.userId ?? 'system';

  if (ctx.mode === 'demo') {
    const action = await withTx(ctx.db, async (scoped) => {
      const tx = scoped as unknown as TxClient;
      const created = await tx.campaignAction.create({
        data: {
          workspaceId,
          campaignId: campaign.id,
          targetStatus: input.targetStatus,
          state: 'SIMULATED',
          previousStatus: campaign.configuredStatus,
          requestedBy: actor,
          idempotencyKey: key,
          createdAt: now,
          resolvedAt: now,
          readBackStatus: input.targetStatus,
          readBackAt: now,
          providerResultRedacted: 'Simulated: no provider contacted.',
        },
      });
      await tx.campaign.update({ where: { id: campaign.id }, data: { configuredStatus: input.targetStatus, effectiveStatus: input.targetStatus } });
      await recordAudit(tx, ctx, {
        action: 'campaign.status.change',
        targetType: 'Campaign',
        targetId: campaign.id,
        simulated: true,
        summary: { actionId: created.id, target: input.targetStatus, previous: campaign.configuredStatus, state: 'SIMULATED' },
      });
      return created;
    });
    return { ...actionView(action), created: true, simulated: true };
  }

  const integration = await ctx.db.integration.findFirst({ where: { kind: 'META_ADS' }, select: { id: true, status: true, verifiedAt: true } });
  if (!isVerified(integration)) {
    await withTx(ctx.db, (scoped) =>
      recordAudit(scoped as unknown as TxClient, ctx, {
        action: 'campaign.status.request',
        targetType: 'Campaign',
        targetId: campaign.id,
        result: 'DENIED',
        summary: { target: input.targetStatus, errorCode: 'INTEGRATION_NOT_VERIFIED', integrationStatus: integration?.status ?? 'NOT_CONFIGURED' },
      }),
    );
    throw new IntegrationNotVerifiedError({ userMessage: 'Meta Lead Ads is not verified, so campaigns cannot be paused or resumed from here. Test the connection on its setup page first.' });
  }

  const action = await withTx(ctx.db, async (scoped) => {
    const tx = scoped as unknown as TxClient;
    const created = await tx.campaignAction.create({
      data: { workspaceId, campaignId: campaign.id, targetStatus: input.targetStatus, state: 'PENDING', previousStatus: campaign.configuredStatus, requestedBy: actor, idempotencyKey: key, createdAt: now },
    });
    const { job } = await enqueueJob(tx, ctx.clock, {
      type: CAMPAIGN_ACTION_JOB,
      payload: { actionId: created.id },
      payloadVersion: META_JOB_PAYLOAD_VERSION,
      workspaceId,
      idempotencyKey: actionJobKey(created.id),
      correlationId: ctx.correlationId,
      kind: 'send',
      serialKey: `campaign:${campaign.id}`,
    });
    await recordAudit(tx, ctx, {
      action: 'campaign.status.request',
      targetType: 'Campaign',
      targetId: campaign.id,
      summary: { actionId: created.id, target: input.targetStatus, previous: campaign.configuredStatus, jobId: job.id },
    });
    return created;
  });
  return { ...actionView(action), created: true, simulated: false };
}

// ---- The job ---------------------------------------------------------------------------------------

export type CampaignJobDeps = LiveAdapterDeps & { mode: 'demo' | 'live' };

type ActionCtx = { job: JobHandlerContext; ctx: AppCtx; action: CampaignAction; workspaceId: string; campaign: { id: string; providerCampaignId: string; configuredStatus: string } };

function payloadOf(job: JobHandlerContext): { actionId: string; workspaceId: string } | null {
  const p = job.job.payload as { actionId?: unknown } | null;
  return typeof p?.actionId === 'string' && job.job.workspaceId !== null ? { actionId: p.actionId, workspaceId: job.job.workspaceId } : null;
}

async function loadAction(job: JobHandlerContext, mode: 'demo' | 'live'): Promise<ActionCtx | JobResult> {
  const p = payloadOf(job);
  if (!p) return { outcome: 'dead', reason: 'INVALID_PAYLOAD', errorCode: 'INVALID_PAYLOAD', error: `${job.job.type} payload is not { actionId }` };
  const action = await job.db.campaignAction.findFirst({ where: { id: p.actionId, workspaceId: p.workspaceId } });
  if (!action) return { outcome: 'dead', reason: 'NOT_FOUND', errorCode: 'NOT_FOUND', error: `no campaign action ${p.actionId} in the job's workspace` };
  const campaign = await job.db.campaign.findFirst({ where: { id: action.campaignId, workspaceId: p.workspaceId }, select: { id: true, providerCampaignId: true, configuredStatus: true } });
  if (!campaign) return { outcome: 'dead', reason: 'NOT_FOUND', errorCode: 'NOT_FOUND', error: 'the campaign of this action is gone' };
  const ctx = getJobContext({ id: job.job.id, workspaceId: p.workspaceId, correlationId: job.correlationId }, { prisma: job.db, mode, clock: job.clock });
  return { job, ctx, action, workspaceId: p.workspaceId, campaign };
}

/** Moves the action from one of `from` to its final or intermediate state, with the audit row; returns false when it moved already. */
async function settleAction(
  tx: TxClient,
  a: ActionCtx,
  from: CampaignAction['state'][],
  to: { state: CampaignAction['state']; reasonCode?: string | null; message?: string | null; readBack?: { configured: string; effective: string } | null; campaignConfigured?: string },
): Promise<boolean> {
  const now = a.job.clock.now();
  const final = to.state === 'SUCCEEDED' || to.state === 'FAILED';
  const moved = await tx.campaignAction.updateMany({
    where: { id: a.action.id, workspaceId: a.workspaceId, state: { in: from } },
    data: {
      state: to.state,
      reasonCode: to.reasonCode ?? null,
      providerResultRedacted: to.message ? bounded(to.message) : null,
      ...(to.readBack ? { readBackStatus: to.readBack.effective, readBackAt: now } : {}),
      ...(final ? { resolvedAt: now } : {}),
    },
  });
  if (moved.count !== 1) return false;
  if (to.readBack) {
    await tx.campaign.updateMany({ where: { id: a.campaign.id, workspaceId: a.workspaceId }, data: { configuredStatus: to.readBack.configured, effectiveStatus: to.readBack.effective, lastSyncedAt: now } });
  } else if (to.campaignConfigured) {
    await tx.campaign.updateMany({ where: { id: a.campaign.id, workspaceId: a.workspaceId }, data: { configuredStatus: to.campaignConfigured } });
  }
  if (to.state !== 'SENDING' && to.state !== 'PENDING') {
    await recordAudit(tx, a.ctx, {
      action: 'campaign.status.change',
      targetType: 'Campaign',
      targetId: a.campaign.id,
      result: to.state === 'SUCCEEDED' ? 'SUCCESS' : 'FAILED',
      summary: { actionId: a.action.id, target: a.action.targetStatus, previous: a.action.previousStatus, state: to.state, reasonCode: to.reasonCode ?? null, readBack: to.readBack?.effective ?? null },
    });
  }
  return true;
}

async function enqueueReadBack(tx: TxClient, a: ActionCtx, at: Date): Promise<void> {
  await enqueueJob(tx, a.job.clock, {
    type: CAMPAIGN_READBACK_JOB,
    payload: { actionId: a.action.id },
    payloadVersion: META_JOB_PAYLOAD_VERSION,
    workspaceId: a.workspaceId,
    idempotencyKey: `${CAMPAIGN_READBACK_JOB}:${a.action.id}`,
    correlationId: a.job.correlationId,
    causationId: a.job.job.id,
    runAt: at,
    kind: 'fetch',
  });
}

const readBackAt = (a: ActionCtx) => new Date(a.job.clock.now().getTime() + CAMPAIGN_READBACK_DELAY_MS);

function unknown(a: ActionCtx, reasonCode: string, message: string): JobResult {
  return {
    outcome: 'succeeded',
    finalTx: async (tx) => {
      if (await settleAction(tx, a, ['SENDING'], { state: 'UNKNOWN', reasonCode, message })) await enqueueReadBack(tx, a, readBackAt(a));
    },
  };
}

export async function runCampaignAction(job: JobHandlerContext, deps: CampaignJobDeps): Promise<JobResult> {
  const loaded = await loadAction(job, deps.mode);
  if (!('action' in loaded)) return loaded;
  const a = loaded;
  if (a.action.state === 'SENDING') {
    // A previous run died during the provider call: never call again blindly, read back instead.
    return unknown(a, 'INTERRUPTED', 'The worker stopped during the call to Meta; confirming the campaign status with Meta.');
  }
  if (a.action.state !== 'PENDING') return { outcome: 'succeeded' };
  if (deps.mode !== 'live') {
    return { outcome: 'succeeded', finalTx: async (tx) => void (await settleAction(tx, a, ['PENDING'], { state: 'FAILED', reasonCode: 'MODE_MISMATCH', message: 'DEMO never contacts Meta.' })) };
  }

  const row = await a.ctx.db.integration.findFirst({ where: { kind: 'META_ADS' }, select: { id: true, status: true, verifiedAt: true } });
  const use = await loadIntegrationForUse(a.ctx.db, 'META_ADS', deps.keyRing);
  const resolved = isVerified(row)
    ? metaMarketingClient({ mode: deps.mode, integration: use, graphVersion: deps.graphVersion, marketingVersion: deps.marketingVersion ?? null, clock: job.clock, usable: SEND_USABLE_STATUSES, ...(deps.graph ? { graph: deps.graph } : {}) })
    : null;
  if (!resolved || !resolved.ok) {
    const code = resolved && !resolved.ok && resolved.code === 'CREDENTIAL_UNREADABLE' ? 'CREDENTIAL_UNREADABLE' : 'INTEGRATION_NOT_VERIFIED';
    const message = resolved && !resolved.ok ? `Not sent: ${resolved.reason}.` : 'Not sent: Meta Lead Ads is not verified.';
    return {
      outcome: 'succeeded',
      finalTx: async (tx) => {
        if (code === 'CREDENTIAL_UNREADABLE' && row) await recordMetaAccessProblem(tx, a.ctx, { id: row.id, workspaceId: a.workspaceId }, { code, message, field: 'accessToken' }, 'campaign.action');
        await settleAction(tx, a, ['PENDING'], { state: 'FAILED', reasonCode: code, message });
      },
    };
  }
  const client: MetaMarketingClient = resolved.value;
  const integration = { id: row!.id, workspaceId: a.workspaceId };
  const target = a.action.targetStatus as CampaignTargetStatus;

  // SENDING is committed before the provider call (plan §4.4).
  const claimed = await job.fencedTx((tx) => tx.campaignAction.updateMany({ where: { id: a.action.id, workspaceId: a.workspaceId, state: 'PENDING' }, data: { state: 'SENDING', reasonCode: null, providerResultRedacted: null } }));
  if (claimed.count !== 1) return { outcome: 'succeeded' };

  const res = await client.setCampaignStatus(a.campaign.providerCampaignId, target);
  if (job.signal.aborted) throw new LeaseLostError(job.job.id);

  if (res.ok) {
    if (res.data.success !== true) return unknown(a, 'UNCONFIRMED', 'Meta answered without confirming the change; confirming the campaign status with Meta.');
    const read = await client.getCampaign(a.campaign.providerCampaignId);
    const status = read.ok ? parseCampaignStatus(read.data) : null;
    return {
      outcome: 'succeeded',
      finalTx: async (tx) => {
        if (status) {
          await settleAction(tx, a, ['SENDING'], { state: 'SUCCEEDED', message: `Meta confirmed the change; the campaign now reads ${status.effectiveStatus}.`, readBack: { configured: status.configuredStatus, effective: status.effectiveStatus } });
        } else if (await settleAction(tx, a, ['SENDING'], { state: 'SUCCEEDED', message: 'Meta confirmed the change; its delivery status is being read back.', campaignConfigured: target })) {
          await enqueueReadBack(tx, a, job.clock.now());
        }
      },
    };
  }

  const f = classifyMetaFailure(res, 'ads_management');
  // 2xx without the documented body, 5xx, or no answer after the request was written: may have applied.
  if (res.phase === 'after-write' || (res.phase === 'response' && (res.status < 300 || res.status >= 500) && f.code !== 'PROVIDER_RATE_LIMITED')) {
    return unknown(a, res.phase === 'after-write' ? 'WRITE_TIMEOUT' : 'PROVIDER_UNAVAILABLE', `${f.message} Confirming the campaign status with Meta.`);
  }
  if (res.phase === 'before-write' || f.code === 'PROVIDER_RATE_LIMITED') {
    const last = job.job.attempts >= job.job.maxAttempts;
    return {
      outcome: 'retry',
      errorCode: f.code,
      error: f.message,
      retryAfterMs: metaBackoffMs(job.job.attempts, f.retryAfterMs),
      finalTx: async (tx) => {
        if (last) await settleAction(tx, a, ['SENDING'], { state: 'FAILED', reasonCode: f.code, message: f.message });
        else await settleAction(tx, a, ['SENDING'], { state: 'PENDING', reasonCode: f.code, message: `Waiting to retry: ${f.message}` });
      },
    };
  }
  const reasonCode = f.code === 'NOT_FOUND' ? 'CAMPAIGN_NOT_FOUND' : f.code;
  return {
    outcome: 'succeeded',
    finalTx: async (tx) => {
      if (f.code === 'PROVIDER_AUTH' || f.code === 'PERMISSION_MISSING') {
        await recordMetaAccessProblem(tx, a.ctx, integration, { code: f.code, message: f.message, permission: f.permission }, 'campaign.action');
      }
      await settleAction(tx, a, ['SENDING'], { state: 'FAILED', reasonCode, message: f.message });
    },
  };
}

/** `campaign.readback`: resolves an UNKNOWN action (or refreshes a confirmed one) from the provider's own status. */
export async function runCampaignReadBack(job: JobHandlerContext, deps: CampaignJobDeps): Promise<JobResult> {
  const loaded = await loadAction(job, deps.mode);
  if (!('action' in loaded)) return loaded;
  const a = loaded;
  if (deps.mode !== 'live') return { outcome: 'succeeded' };
  const unresolved = a.action.state === 'UNKNOWN';
  if (!unresolved && (a.action.state !== 'SUCCEEDED' || a.action.readBackAt !== null)) return { outcome: 'succeeded' };

  const use = await loadIntegrationForUse(a.ctx.db, 'META_ADS', deps.keyRing);
  const resolved = metaMarketingClient({ mode: deps.mode, integration: use, graphVersion: deps.graphVersion, marketingVersion: deps.marketingVersion ?? null, clock: job.clock, usable: CHECKABLE_STATUSES, ...(deps.graph ? { graph: deps.graph } : {}) });
  if (!resolved.ok) return { outcome: 'dead', reason: 'INTEGRATION_NOT_CONFIGURED', errorCode: 'INTEGRATION_NOT_CONFIGURED', error: resolved.reason, finalTx: noteReadBackFailure(a, 'READBACK_FAILED', `The status could not be read back: ${resolved.reason}. Check the campaign in Ads Manager.`) };
  const read = await resolved.value.getCampaign(a.campaign.providerCampaignId);
  if (job.signal.aborted) throw new LeaseLostError(job.job.id);
  const status = read.ok ? parseCampaignStatus(read.data) : null;
  if (!status) {
    const f = read.ok ? null : classifyMetaFailure(read, 'ads_read');
    const message = f ? f.message : 'Meta answered without the campaign status.';
    const last = job.job.attempts >= job.job.maxAttempts;
    return {
      outcome: 'retry',
      errorCode: f?.code ?? 'PROVIDER_REJECTED',
      error: message,
      retryAfterMs: metaBackoffMs(job.job.attempts, f?.retryAfterMs),
      ...(last ? { finalTx: noteReadBackFailure(a, 'READBACK_FAILED', `${message} The outcome stays unknown: check the campaign in Ads Manager.`) } : {}),
    };
  }
  const target = a.action.targetStatus.toUpperCase();
  return {
    outcome: 'succeeded',
    finalTx: async (tx) => {
      const readBack = { configured: status.configuredStatus, effective: status.effectiveStatus };
      if (!unresolved) {
        await tx.campaignAction.updateMany({ where: { id: a.action.id, workspaceId: a.workspaceId }, data: { readBackStatus: status.effectiveStatus, readBackAt: job.clock.now() } });
        await tx.campaign.updateMany({ where: { id: a.campaign.id, workspaceId: a.workspaceId }, data: { configuredStatus: readBack.configured, effectiveStatus: readBack.effective, lastSyncedAt: job.clock.now() } });
        return;
      }
      if (status.configuredStatus.toUpperCase() === target) {
        await settleAction(tx, a, ['UNKNOWN'], { state: 'SUCCEEDED', reasonCode: null, message: `Confirmed by reading the status back from Meta: ${status.effectiveStatus}.`, readBack });
      } else {
        await settleAction(tx, a, ['UNKNOWN'], { state: 'FAILED', reasonCode: 'READBACK_NOT_APPLIED', message: `Meta shows the campaign as ${status.configuredStatus}: the change did not apply. Try again.`, readBack });
      }
    },
  };
}

function noteReadBackFailure(a: ActionCtx, reasonCode: string, message: string): FinalTx {
  return async (tx) => {
    await tx.campaignAction.updateMany({ where: { id: a.action.id, workspaceId: a.workspaceId, state: { in: ['UNKNOWN', 'SUCCEEDED'] } }, data: { reasonCode, providerResultRedacted: bounded(message) } });
    await recordAudit(tx, a.ctx, { action: 'campaign.status.readback', targetType: 'Campaign', targetId: a.campaign.id, result: 'FAILED', summary: { actionId: a.action.id, reasonCode } });
  };
}

/** For read models: the newest action per campaign. */
export async function latestActions(ctx: AppCtx, campaignIds: string[]): Promise<Map<string, CampaignActionView>> {
  if (campaignIds.length === 0) return new Map();
  const rows = await ctx.db.campaignAction.findMany({ where: { campaignId: { in: campaignIds } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200 });
  const out = new Map<string, CampaignActionView>();
  for (const r of rows) if (!out.has(r.campaignId)) out.set(r.campaignId, actionView(r));
  return out;
}

