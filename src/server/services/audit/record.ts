/**
 * The audit writer (R7, plan §9 Logging). Callers pass the transaction that performs the state
 * change, so the AuditEvent commits or rolls back with it. The summary is passed through
 * `redact()` before it is stored: summaries name the fields that changed and carry counts or
 * codes, never PII values. Actor, workspace, correlation id and time all come from the context.
 */
import type { ActorKind, AuditResult, Prisma } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import type { Actor, CtxKind } from '@/lib/domain/context';
import { redact } from '@/lib/redact';

export type AuditCtx = {
  kind: CtxKind;
  actor: Actor | null;
  workspaceId: string | null;
  correlationId: string;
  clock: Clock;
  elevated?: { reason: string; auditEventId: string };
};

export type AuditSummary = { fields?: readonly string[] } & Record<string, unknown>;

export type AuditInput = {
  action: string;
  targetType: string;
  targetId: string;
  result?: AuditResult;
  summary?: AuditSummary;
  reason?: string | null;
  crossWorkspace?: boolean;
  simulated?: boolean;
  /** Defaults to ctx.workspaceId. A scoped client rejects any other value (404). */
  workspaceId?: string | null;
};

/** A client, a transaction client or a scoped client: anything that can create an AuditEvent. */
export type AuditDb = {
  auditEvent: {
    create(args: { data: Prisma.AuditEventUncheckedCreateInput; select: { id: true } }): PromiseLike<{ id: string }>;
  };
};

export function actorKindOf(ctx: Pick<AuditCtx, 'kind' | 'actor'>): ActorKind {
  switch (ctx.kind) {
    case 'user':
      return ctx.actor?.role ?? 'PUBLIC';
    case 'job':
      return 'WORKER';
    case 'system':
      return 'SYSTEM';
    case 'webhook':
      return 'WEBHOOK';
    case 'public':
      return 'PUBLIC';
  }
}

export async function recordAudit(db: AuditDb, ctx: AuditCtx, input: AuditInput): Promise<{ id: string }> {
  const summary = redact(input.summary ?? {}) as Prisma.InputJsonValue;
  return db.auditEvent.create({
    data: {
      workspaceId: input.workspaceId === undefined ? ctx.workspaceId : input.workspaceId,
      actorUserId: ctx.actor?.userId ?? null,
      actorKind: actorKindOf(ctx),
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      result: input.result ?? 'SUCCESS',
      summary,
      crossWorkspace: input.crossWorkspace ?? ctx.elevated !== undefined,
      reason: input.reason ?? ctx.elevated?.reason ?? null,
      correlationId: ctx.correlationId,
      simulated: input.simulated ?? false,
      createdAt: ctx.clock.now(),
    },
    select: { id: true },
  });
}
