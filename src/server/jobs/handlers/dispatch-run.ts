/**
 * The dispatch job body shared by `dispatch.whatsapp` and `dispatch.email` (plan §4.4, C7, E5, E7).
 * Payload v1 `{ messageId }`, workspace job, kind send (5 attempts), serialKey = conversationId.
 *
 *   P1  pause point `dispatch.p1` (after the claim, before preflight)
 *   1   preflight in a fenced, tenant-scoped transaction -> SENDING committed (or skip/cancel/defer)
 *   P2  `dispatch.p2`; a lost lease here stops before the call (the reaper makes it AMBIGUOUS)
 *   2   provider call through the channel transport, outside any transaction
 *   P3  `dispatch.p3`
 *   3   settle in the runner's fenced settle transaction (finalTx), together with the job state
 *
 * Pauses: SystemSetting.outboundPaused, `outbound.lock` in the data dir and OUTBOUND_PAUSED=1 all
 * defer (O1); workspace automation pause defers automated sends only (eligibility check 2).
 */
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { Channel } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import { getConfig } from '@/lib/config';
import { LeaseLostError, fenceJob } from '@/server/db/fence';
import type { ScopedTx } from '@/server/db/scoped';
import { withTx } from '@/server/db/tx';
import { createDemoEmailTransport } from '@/server/adapters/email/demo';
import type { EmailTransport } from '@/server/adapters/email/port';
import { boundedError } from '@/server/adapters/whatsapp/error-map';
import { createDemoWhatsAppTransport, createFileDemoOutbox, demoOutboxDir } from '@/server/adapters/whatsapp/demo';
import type { SendOutcome, WhatsAppTransport } from '@/server/adapters/whatsapp/port';
import { readArtifactFile } from '@/server/pdf/artifacts';
import {
  ARTIFACT_RECHECK_MS,
  DISPATCH_PAYLOAD_VERSION,
  dispatchJobType,
  deriveUnsubscribeKey,
  preflightDispatch,
  settleAmbiguous,
  settleArtifactMissing,
  settleFailed,
  settleSent,
  signUnsubscribeToken,
  unsubscribeLinks,
  withUnsubscribeFooter,
  type PreflightResult,
  type SendPlan,
} from '@/server/services/messaging/dispatch';
import { pausePoint } from '@/server/testing/pause';
import type { JobDefinition, JobHandlerContext, JobResult } from '../types';
import { jobCtx, parseWorkspacePayload } from './lead-job-support';

const payloadSchema = z.object({ messageId: z.string().min(1).max(64) });

export type DispatchRuntimeDeps = {
  contactKeyPepper: string;
  storageDir: string;
  appOrigin: string;
  /** Signs the unsubscribe link every email carries (derived from SESSION_SECRET). */
  unsubscribeKey: Buffer | null;
  outboundLockFile: string;
  envOutboundPaused: boolean;
};

export type TransportEnv = { mode: 'demo' | 'live'; clock: Clock; storageDir: string };

export type DispatchJobOptions = {
  mode?: () => 'demo' | 'live';
  deps?: () => DispatchRuntimeDeps;
  /** null = no transport for this mode (LIVE until T32 / T33 register theirs): skipped NOT_CONFIGURED. */
  whatsapp?: (env: TransportEnv) => WhatsAppTransport | null;
  email?: (env: TransportEnv) => EmailTransport | null;
};

export function dispatchDepsFromConfig(): DispatchRuntimeDeps {
  const config = getConfig();
  const pepper = config.secrets.suppressionPepper;
  if (!pepper) throw new Error('SUPPRESSION_PEPPER is required for dispatch (run npm run setup)');
  return {
    contactKeyPepper: pepper,
    storageDir: config.paths.storageDir,
    appOrigin: config.appOrigin,
    unsubscribeKey: config.secrets.sessionSecret ? deriveUnsubscribeKey(config.secrets.sessionSecret) : null,
    outboundLockFile: config.paths.outboundLockFile,
    envOutboundPaused: config.outboundPaused,
  };
}

/** DEMO: the recording demo transports (zero network). LIVE: the provider adapters, added by T32 (WhatsApp) and T33 (email). */
export function defaultWhatsAppTransport(env: TransportEnv): WhatsAppTransport | null {
  return env.mode === 'demo' ? createDemoWhatsAppTransport(createFileDemoOutbox(demoOutboxDir(env.storageDir)), env.clock) : null;
}

export function defaultEmailTransport(env: TransportEnv): EmailTransport | null {
  return env.mode === 'demo' ? createDemoEmailTransport(createFileDemoOutbox(demoOutboxDir(env.storageDir)), env.clock) : null;
}

/** A tenant-scoped transaction whose first statement (after the write lock) is the claimToken fence (E5). */
function scopedFencedTx<R>(job: JobHandlerContext, db: { $transaction: unknown }, fn: (tx: ScopedTx) => Promise<R>): Promise<R> {
  return withTx(db as never, async (tx: ScopedTx) => {
    await fenceJob(tx as never, job.job.id, job.job.claimToken, job.clock.now());
    return fn(tx);
  });
}

async function sendPlan(channel: Channel, plan: SendPlan, deps: DispatchRuntimeDeps, wa: WhatsAppTransport | null, email: EmailTransport | null): Promise<SendOutcome> {
  let document = null;
  if (plan.artifact) {
    try {
      const bytes = readArtifactFile(deps.storageDir, plan.artifact);
      document = { filename: plan.artifact.filename, bytes, sha256: plan.artifact.sha256 };
    } catch (error) {
      // Missing or altered file: definitely not sent, and retrying cannot fix it.
      return {
        status: 'failed',
        failureClass: 'PERMANENT',
        reasonCode: 'ARTIFACT_INTEGRITY',
        error: boundedError(error instanceof Error ? error.message : String(error)),
        suppress: false,
        manualRetryAfterMs: null,
        throttleScope: null,
      };
    }
  }
  try {
    if (channel === 'WHATSAPP') {
      if (!wa) throw new Error('no WhatsApp transport');
      return await wa.send({
        attemptId: plan.attemptId,
        idempotencyKey: plan.idempotencyKey,
        workspaceId: plan.workspaceId,
        to: plan.to,
        kind: plan.kind === 'WA_TEMPLATE' ? 'template' : 'freeform',
        template: plan.template ? { name: plan.template.name, language: plan.template.language, variables: plan.variables } : null,
        body: plan.body,
        document: document ? { ...document, mimeType: 'application/pdf' } : null,
      });
    }
    if (!email) throw new Error('no email transport');
    if (!deps.unsubscribeKey) {
      return { status: 'failed', failureClass: 'PERMANENT', reasonCode: 'UNSUBSCRIBE_KEY_MISSING', error: 'SESSION_SECRET is not set', suppress: false, manualRetryAfterMs: null, throttleScope: null };
    }
    const token = signUnsubscribeToken(deps.unsubscribeKey, { workspaceId: plan.workspaceId, contactKey: plan.destinationKey });
    const links = unsubscribeLinks(deps.appOrigin, token);
    return await email.send({
      attemptId: plan.attemptId,
      idempotencyKey: plan.idempotencyKey,
      workspaceId: plan.workspaceId,
      from: { name: plan.workspace.name, address: `quotes@${plan.workspace.slug}.invalid` },
      to: plan.to,
      subject: plan.subject ?? '',
      text: withUnsubscribeFooter(plan.body ?? '', plan.workspace.name, links.pageUrl),
      headers: links.headers,
      attachments: document ? [{ ...document, contentType: 'application/pdf' }] : [],
    });
  } catch (error) {
    // The transport threw instead of classifying: the request may have been written.
    return { status: 'ambiguous', reasonCode: 'TRANSPORT_EXCEPTION', error: boundedError(error instanceof Error ? error.message : String(error)) };
  }
}

export function createDispatchJob(channel: Channel, options: DispatchJobOptions = {}): JobDefinition {
  const mode = options.mode ?? (() => getConfig().mode);
  const deps = options.deps ?? dispatchDepsFromConfig;
  const waFactory = options.whatsapp ?? defaultWhatsAppTransport;
  const emailFactory = options.email ?? defaultEmailTransport;
  return {
    type: dispatchJobType(channel),
    kind: 'send',
    payloadVersions: [DISPATCH_PAYLOAD_VERSION],
    async handler(job): Promise<JobResult> {
      const parsed = parseWorkspacePayload(job, payloadSchema);
      if (!parsed.ok) return parsed.result;
      const { workspaceId, payload } = parsed;
      await pausePoint('dispatch.p1', { jobId: job.job.id });

      const m = mode();
      const d = deps();
      const env: TransportEnv = { mode: m, clock: job.clock, storageDir: d.storageDir };
      const wa = channel === 'WHATSAPP' ? waFactory(env) : null;
      const email = channel === 'EMAIL' ? emailFactory(env) : null;
      const ctx = jobCtx(job, workspaceId, m);
      const externalOutboundPause = d.envOutboundPaused || existsSync(d.outboundLockFile);

      const pre: PreflightResult = await scopedFencedTx(job, ctx.db, (tx) =>
        preflightDispatch(tx, ctx, { messageId: payload.messageId, jobId: job.job.id }, {
          contactKeyPepper: d.contactKeyPepper,
          externalOutboundPause,
          transportAvailable: (channel === 'WHATSAPP' ? wa : email) !== null,
        }),
      );
      switch (pre.kind) {
        case 'cancelled':
          return { outcome: 'cancelled', reason: pre.reason };
        case 'done':
        case 'skipped':
          return { outcome: 'succeeded' };
        case 'deferred':
          return { outcome: 'deferred', runAt: pre.runAt, reason: pre.reason };
        case 'artifact-pending': {
          const last = job.job.attempts >= job.job.maxAttempts;
          return {
            outcome: 'retry',
            errorCode: 'ARTIFACT_NOT_READY',
            error: 'the quotation PDF is not rendered yet',
            retryAfterMs: ARTIFACT_RECHECK_MS,
            ...(last ? { finalTx: (tx) => settleArtifactMissing(tx, ctx, { workspaceId, attemptId: pre.attemptId, messageId: pre.messageId }) } : {}),
          };
        }
        case 'send':
          break;
      }
      const plan = pre.plan;

      await pausePoint('dispatch.p2', { jobId: job.job.id, attemptId: plan.attemptId });
      if (job.signal.aborted) throw new LeaseLostError(job.job.id);

      const outcome = await sendPlan(channel, plan, d, wa, email);
      await pausePoint('dispatch.p3', { jobId: job.job.id, attemptId: plan.attemptId });

      switch (outcome.status) {
        case 'sent':
          return { outcome: 'succeeded', finalTx: (tx) => settleSent(tx, ctx, plan, outcome) };
        case 'ambiguous':
          return {
            outcome: 'dead',
            reason: 'AMBIGUOUS',
            errorCode: outcome.reasonCode,
            error: outcome.error,
            retrySafe: false,
            finalTx: (tx) => settleAmbiguous(tx, ctx, plan, outcome),
          };
        case 'failed': {
          if (outcome.failureClass === 'PERMANENT') {
            return { outcome: 'succeeded', finalTx: (tx) => settleFailed(tx, ctx, plan, outcome, { retryNext: false, jobId: job.job.id }, d) };
          }
          const retryNext = job.job.attempts < job.job.maxAttempts;
          return {
            outcome: 'retry',
            errorCode: outcome.reasonCode,
            error: outcome.error,
            ...(outcome.retryAfterMs !== undefined ? { retryAfterMs: outcome.retryAfterMs } : {}),
            finalTx: (tx) => settleFailed(tx, ctx, plan, outcome, { retryNext, jobId: job.job.id }, d),
          };
        }
      }
    },
  };
}
