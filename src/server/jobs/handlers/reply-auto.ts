/**
 * `reply.auto` (T21): the guarded automated reply to one inbound WhatsApp text message.
 * Payload v1 `{ conversationId, inboundMessageId }`, workspace job, kind default,
 * serialKey = conversationId (per-conversation ordering with the thread's dispatch jobs),
 * idempotency key `reply.auto:<inboundMessageId>`; enqueued by `webhook.process`.
 *
 * The whole body runs in one fenced, tenant-scoped transaction (E5) with no network: the reply
 * guard writes fixed texts or catalog facts only (no model call), and an AUTO reply is queued
 * through the dispatch outbox, whose own job makes the provider call after its preflight.
 * A replay finds the reply it already made and adds nothing.
 */
import { z } from 'zod';
import { getConfig } from '@/lib/config';
import { fenceJob } from '@/server/db/fence';
import type { ScopedTx } from '@/server/db/scoped';
import { withTx } from '@/server/db/tx';
import { generateAutoReply, REPLY_AUTO_JOB, REPLY_PAYLOAD_VERSION, type ReplyDeps } from '@/server/services/messaging/conversations';
import type { JobDefinition, JobHandlerContext } from '../types';
import { jobCtx, parseWorkspacePayload } from './lead-job-support';

const payloadSchema = z.object({ conversationId: z.string().min(1).max(64), inboundMessageId: z.string().min(1).max(64) });

export function replyAutoDepsFromConfig(): ReplyDeps {
  const pepper = getConfig().secrets.suppressionPepper;
  if (!pepper) throw new Error('SUPPRESSION_PEPPER is not configured (run `npm run setup`).');
  return { contactKeyPepper: pepper };
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
    kind: 'default',
    payloadVersions: [REPLY_PAYLOAD_VERSION],
    async handler(job) {
      const parsed = parseWorkspacePayload(job, payloadSchema);
      if (!parsed.ok) return parsed.result;
      const ctx = jobCtx(job, parsed.workspaceId, mode());
      const d = deps();
      await scopedFencedTx(job, ctx.db, (tx) => generateAutoReply(tx, ctx, parsed.payload, d));
      return { outcome: 'succeeded' };
    },
  };
}

export const replyAutoJob = createReplyAutoJob();
