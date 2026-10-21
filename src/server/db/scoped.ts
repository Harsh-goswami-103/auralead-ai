/**
 * Tenant scoping (T1, A6, E10, ADR-42).
 *
 * `scopeDb(client, workspaceId)` returns a Prisma client extension that, for every tenant model:
 * - adds `workspaceId = <scope>` to the `where` of every read, update, delete, count, aggregate
 *   and groupBy (so another tenant's id simply matches nothing: findUnique returns null);
 * - sets `workspaceId` on every create, createMany and upsert-create;
 * - throws `TenantScopeError` when the caller names a different workspaceId in `where` or `data`;
 * - throws `TenantScopeError` for any tenant-model access when the scope is null (no workspace in
 *   the context), so unscoped tenant queries fail closed.
 * Identity and platform models (Workspace, User, Session, SystemSetting, TestClock,
 * WorkerHeartbeat) pass through unchanged.
 *
 * Limits, by design: nested relation writes are not rewritten (the composite foreign keys
 * (workspaceId, parentId) reject a cross-workspace child at the database level), and
 * `$queryRaw`/`$executeRaw` are not scoped (raw SQL lives in src/server/db/raw and binds
 * workspaceId explicitly). Writes through the scoped client use the unchecked (scalar foreign key)
 * input form. Platform code that legitimately spans workspaces (worker claim, reaper, admin
 * context after its audit row) uses the base client.
 *
 * `assertSameWorkspace(tx, ctx, refs)` validates ids taken from a request body against the
 * context workspace inside the transaction and throws a 404 `TenantScopeError` on any mismatch.
 */
import type { Prisma, PrismaClient } from '@/generated/prisma/client';

/** Tenant models whose workspaceId is required. Kept in sync with schema.prisma by tests/unit/arch/tenant-columns.test.ts. */
export const REQUIRED_TENANT_MODELS = [
  'WorkspaceSettings',
  'Membership',
  'EmployeeAssignment',
  'Lead',
  'LeadContactKey',
  'LeadSourceRecord',
  'ImportBatch',
  'MergeReview',
  'ConsentRecord',
  'Suppression',
  'ScoringConfigVersion',
  'SheetMapping',
  'MetaFormMapping',
  'Service',
  'PricingVersion',
  'PriceEntry',
  'Quote',
  'QuoteVersion',
  'QuoteItem',
  'QuoteShare',
  'QuoteViewEvent',
  'QuoteAcceptance',
  'QuoteArtifact',
  'Approval',
  'Conversation',
  'Message',
  'MessageStatusEvent',
  'DispatchAttempt',
  'CallRequest',
  'WhatsAppTemplate',
  'Campaign',
  'CampaignMetricSnapshot',
  'CampaignAction',
  'Integration',
  'ExtensionToken',
  'PipelineConfigVersion',
  'PipelineExecution',
  'PipelineStageRun',
  'AiDraft',
  'BulkRun',
  'LeadExport',
  'MetaLeadBackfill',
] as const satisfies readonly Prisma.ModelName[];

/** Tenant models whose workspaceId is nullable (system rows). Scoped access still filters by workspace. */
export const NULLABLE_TENANT_MODELS: ReadonlySet<Prisma.ModelName> = new Set<Prisma.ModelName>([
  'Invite',
  'WebhookEvent',
  'WebhookRejection',
  'Job',
  'JobAttempt',
  'AuditEvent',
]);

export const TENANT_MODELS: ReadonlySet<Prisma.ModelName> = new Set<Prisma.ModelName>([
  ...REQUIRED_TENANT_MODELS,
  ...NULLABLE_TENANT_MODELS,
]);

export type TenantScopeReason = 'UNSCOPED' | 'WORKSPACE_MISMATCH' | 'FOREIGN_REFERENCE';

/** Cross-tenant or unscoped access. Always surfaces as 404 (never reveal that the row exists). */
export class TenantScopeError extends Error {
  readonly code = 'NOT_FOUND';
  readonly status = 404;
  readonly reason: TenantScopeReason;
  /** For FOREIGN_REFERENCE: the ref keys that failed (never the ids themselves). */
  readonly refs: readonly string[];

  constructor(reason: TenantScopeReason, detail: string, refs: readonly string[] = []) {
    super(`tenant scope violation (${reason}): ${detail}`);
    this.name = 'TenantScopeError';
    this.reason = reason;
    this.refs = refs;
  }
}

const WHERE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);
const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);
const UPDATE_DATA_OPERATIONS = new Set(['update', 'updateMany', 'updateManyAndReturn']);

type Args = Record<string, unknown>;

function isRecord(value: unknown): value is Args {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkNamedWorkspace(model: string, where: string, value: unknown, workspaceId: string): void {
  if (value === undefined || value === workspaceId) return;
  throw new TenantScopeError('WORKSPACE_MISMATCH', `${model}: ${where}.workspaceId differs from the scoped workspace`);
}

function scopeWhere(model: string, where: unknown, workspaceId: string): Args {
  const base = isRecord(where) ? where : {};
  checkNamedWorkspace(model, 'where', base.workspaceId, workspaceId);
  return { ...base, workspaceId };
}

function scopeCreateData(model: string, data: unknown, workspaceId: string): Args {
  if (!isRecord(data)) throw new TenantScopeError('WORKSPACE_MISMATCH', `${model}: create data must be an object`);
  if ('workspace' in data) {
    throw new TenantScopeError('WORKSPACE_MISMATCH', `${model}: use the workspaceId column, not a workspace relation, through the scoped client`);
  }
  checkNamedWorkspace(model, 'data', data.workspaceId, workspaceId);
  return { ...data, workspaceId };
}

function checkUpdateData(model: string, data: unknown, workspaceId: string): void {
  if (!isRecord(data)) return;
  if ('workspace' in data) throw new TenantScopeError('WORKSPACE_MISMATCH', `${model}: the workspace relation cannot be changed`);
  checkNamedWorkspace(model, 'data', data.workspaceId, workspaceId);
}

/** Rewrites one operation's arguments for `workspaceId`. Exported for unit-level reuse; fails closed on unknown operations. */
export function scopeArgs(model: string, operation: string, rawArgs: unknown, workspaceId: string): Args {
  const args: Args = isRecord(rawArgs) ? { ...rawArgs } : {};
  if (CREATE_OPERATIONS.has(operation)) {
    args.data = Array.isArray(args.data)
      ? args.data.map((row) => scopeCreateData(model, row, workspaceId))
      : scopeCreateData(model, args.data, workspaceId);
    return args;
  }
  if (!WHERE_OPERATIONS.has(operation)) {
    throw new TenantScopeError('WORKSPACE_MISMATCH', `${model}.${operation} is not supported by the scoped client`);
  }
  args.where = scopeWhere(model, args.where, workspaceId);
  if (UPDATE_DATA_OPERATIONS.has(operation)) checkUpdateData(model, args.data, workspaceId);
  if (operation === 'upsert') {
    args.create = scopeCreateData(model, args.create, workspaceId);
    checkUpdateData(model, args.update, workspaceId);
  }
  return args;
}

export function scopeDb(client: PrismaClient, workspaceId: string | null) {
  return client.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!TENANT_MODELS.has(model)) return query(args);
          if (workspaceId === null) {
            throw new TenantScopeError('UNSCOPED', `${model}.${operation} needs a workspace-scoped context`);
          }
          return query(scopeArgs(model, operation, args, workspaceId) as typeof args);
        },
      },
    },
  });
}

/** A tenant-scoped client (`ctx.db`). */
export type ScopedDb = ReturnType<typeof scopeDb>;
/** The client handed to an interactive transaction on a ScopedDb. */
export type ScopedTx = Omit<ScopedDb, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;

/** Ids a request body may reference, mapped to the model delegate that owns them. */
const REF_MODELS = {
  serviceId: 'service',
  quoteId: 'quote',
  quoteVersionId: 'quoteVersion',
  leadId: 'lead',
  conversationId: 'conversation',
  templateId: 'whatsAppTemplate',
  pricingVersionId: 'pricingVersion',
  messageId: 'message',
  integrationId: 'integration',
  approvalId: 'approval',
  campaignId: 'campaign',
} as const;

export type WorkspaceRefKey = keyof typeof REF_MODELS;
export type WorkspaceRefs = Partial<Record<WorkspaceRefKey, string | readonly string[] | null | undefined>>;
type RefDelegate = (typeof REF_MODELS)[WorkspaceRefKey];

/** A base client, a transaction client or a scoped client: anything exposing the referenced delegates. */
export type RefCheckDb = { [K in RefDelegate]: unknown };

type CountDelegate = { count(args: { where: { id: { in: string[] }; workspaceId: string } }): Promise<number> };

/**
 * Throws a 404 `TenantScopeError` unless every given id exists in `ctx.workspaceId`. Call it
 * inside the transaction that uses the ids, before any write (E10).
 */
export async function assertSameWorkspace(tx: RefCheckDb, ctx: { workspaceId: string | null }, refs: WorkspaceRefs): Promise<void> {
  const workspaceId = ctx.workspaceId;
  if (workspaceId === null) throw new TenantScopeError('UNSCOPED', 'assertSameWorkspace needs a workspace-scoped context');
  const failed: string[] = [];
  for (const key of Object.keys(refs) as WorkspaceRefKey[]) {
    const delegateName = REF_MODELS[key];
    if (delegateName === undefined) throw new TenantScopeError('FOREIGN_REFERENCE', `unknown reference key ${String(key)}`);
    const value = refs[key];
    if (value === null || value === undefined) continue;
    const ids = [...new Set(typeof value === 'string' ? [value] : value)];
    if (ids.length === 0) continue;
    const delegate = tx[delegateName] as CountDelegate;
    const found = await delegate.count({ where: { id: { in: ids }, workspaceId } });
    if (found !== ids.length) failed.push(key);
  }
  if (failed.length > 0) throw new TenantScopeError('FOREIGN_REFERENCE', `referenced ids outside the workspace: ${failed.join(', ')}`, failed);
}
