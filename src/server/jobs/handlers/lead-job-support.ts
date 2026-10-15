/**
 * Shared bits of the T12 lead jobs (`lead.enrich`, `lead.score`, `lead.rescore`): payload
 * parsing and a workspace-scoped job context. Payloads carry ids only (plan §4.3).
 */
import { z } from 'zod';
import { getJobContext, type AppCtx } from '@/server/auth/context';
import type { JobHandlerContext, JobResult } from '../types';

export const leadPayloadSchema = z.object({ leadId: z.string().min(1).max(64) });

export function deadResult(reason: string, error: string): JobResult {
  return { outcome: 'dead', reason, errorCode: reason, error };
}

/** Parses the payload and requires a workspace job; returns a dead result when either fails. */
export function parseWorkspacePayload<S extends z.ZodType>(
  job: JobHandlerContext,
  schema: S,
): { ok: true; payload: z.infer<S>; workspaceId: string } | { ok: false; result: JobResult } {
  const parsed = schema.safeParse(job.job.payload);
  if (!parsed.success) return { ok: false, result: deadResult('INVALID_PAYLOAD', `${job.job.type} payload does not match its schema`) };
  if (job.job.workspaceId === null) return { ok: false, result: deadResult('INVALID_PAYLOAD', `${job.job.type} needs a workspace job`) };
  return { ok: true, payload: parsed.data, workspaceId: job.job.workspaceId };
}

export function jobCtx(job: JobHandlerContext, workspaceId: string, mode: 'demo' | 'live'): AppCtx {
  return getJobContext({ id: job.job.id, workspaceId, correlationId: job.correlationId }, { prisma: job.db, mode, clock: job.clock });
}
