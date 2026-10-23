/**
 * `reply.auto` (T21, ADR-122): the automated reply to one inbound WhatsApp text message.
 * Payload v1 `{ conversationId, inboundMessageId }`, workspace job, kind `ai` (3 attempts),
 * serialKey = conversationId (per-conversation ordering with the thread's dispatch jobs),
 * idempotency key `reply.auto:<inboundMessageId>`; enqueued by `webhook.process`.
 *
 * Two steps, so no provider call ever runs inside a transaction (ADR-60):
 *  1. `prepareAutoReply`, outside any transaction: reads the thread, runs the reply guard and, for
 *     a service question only, the `conversation_reply` model task. A retryable provider failure is
 *     rethrown (the runtime retries with backoff); on the last attempt it becomes the fixed handoff.
 *  2. `commitAutoReply`, in one fenced, tenant-scoped transaction (E5): re-checks the thread (still
 *     the newest inbound, mode, takeover, handoff, window, then consent through the eligibility
 *     check), writes the audit and escalation, and queues the reply through the dispatch outbox
 *     (whose own job makes the provider call after its preflight) or drafts it for approval.
 * A replay finds the reply it already made and adds nothing.
 */
import { z } from 'zod';
import { getConfig } from '@/lib/config';
import { fenceJob } from '@/server/db/fence';
import type { ScopedTx } from '@/server/db/scoped';
import { withTx } from '@/server/db/tx';
import { defaultAiDeps } from '@/server/services/ai/run-task';
import { commitAutoReply, prepareAutoReply, REPLY_AUTO_JOB, REPLY_PAYLOAD_VERSION, type ReplyDeps } from '@/server/services/messaging/conversations';
import type { JobDefinition, JobHandlerContext } from '../types';
import { jobCtx, parseWorkspacePayload } from './lead-job-support';

const payloadSchema = z.object({ conversationId: z.string().min(1).max(64), inboundMessageId: z.string().min(1).max(64) });

export function replyAutoDepsFromConfig(): ReplyDeps {
  const pepper = getConfig().secrets.suppressionPepper;
  if (!pepper) throw new Error('SUPPRESSION_PEPPER is not configured (run `npm run setup`).');
  return { contactKeyPepper: pepper, ai: defaultAiDeps() };
}

/** A tenant-scoped transaction whose first statement (after the write lock) is the claimToken fence (E5). */
function scopedFencedTx<R>(job: JobHandlerContext, db: { $transaction: unknown }, fn: (tx: ScopedTx) => Promise<R>): Promise<R> {
  return withTx(db as never, async (tx: ScopedTx) => {
    await fenceJob(tx as never, job.job.id, job.job.claimToken, job.clock.now());
    return fn(tx);
  });
}

export function createReplyAutoJob(options: { mode?: () => 'demo' | 'live'; deps?: () => ReplyDeps } = {}): JobDefinition {
  const mode = options.mode ?? (() => getConfig().mode);
  const deps = options.deps ?? replyAutoDepsFromConfig;
  return {
    type: REPLY_AUTO_JOB,
    kind: 'ai',
    payloadVersions: [REPLY_PAYLOAD_VERSION],
    async handler(job) {
      const parsed = parseWorkspacePayload(job, payloadSchema);
      if (!parsed.ok) return parsed.result;
      const ctx = jobCtx(job, parsed.workspaceId, mode());
      const d = deps();
      const prepared = await prepareAutoReply(ctx, parsed.payload, d, { finalAttempt: job.job.attempts >= job.job.maxAttempts });
      await scopedFencedTx(job, ctx.db, (tx) => commitAutoReply(tx, ctx, parsed.payload, prepared, d));
      return { outcome: 'succeeded' };
    },
  };
}

export const replyAutoJob = createReplyAutoJob();
