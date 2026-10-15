/**
 * The job claim (plan §4.3, C7): one `UPDATE ... RETURNING` statement, so two worker processes
 * can never claim the same row. Zero rows means nothing is claimable or the race was lost; the
 * caller loops. Dates are bound as `Date` parameters, which the adapter writes in the same
 * ISO-8601 representation Prisma uses for typed writes (verified in T02), so `runAt <= ?` and the
 * values written here read back exactly through the typed client.
 *
 * The same SQL runs on PostgreSQL; `FOR UPDATE SKIP LOCKED` in the subquery is the documented
 * upgrade (plan §5.8). All identifiers are quoted.
 */
import type { JobStatus, PrismaClient } from '@/generated/prisma/client';

export type ClaimInput = {
  /** Claim time: compared against runAt and written to startedAt and updatedAt. */
  now: Date;
  leaseUntil: Date;
  /** Fresh random token per claim; every later job-driven tx is fenced on it (E5). */
  claimToken: string;
};

export type ClaimedJob = {
  id: string;
  workspaceId: string | null;
  type: string;
  payload: unknown;
  payloadVersion: number;
  status: JobStatus;
  priority: number;
  runAt: Date;
  attempts: number;
  maxAttempts: number;
  claimToken: string;
  leaseUntil: Date;
  startedAt: Date;
  serialKey: string | null;
  idempotencyKey: string;
  cancelRequestedAt: Date | null;
  retrySafe: boolean;
  correlationId: string;
  causationId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type RawRow = Record<string, unknown>;

/** Anything that can run a tagged raw query: a client or an interactive-transaction client. */
export type ClaimDb = Pick<PrismaClient, '$queryRaw'>;

export async function claimNextJob(db: ClaimDb, input: ClaimInput): Promise<ClaimedJob | null> {
  const { now, leaseUntil, claimToken } = input;
  const rows = await db.$queryRaw<RawRow[]>`
    UPDATE "Job"
       SET "status" = 'RUNNING', "claimToken" = ${claimToken}, "leaseUntil" = ${leaseUntil},
           "attempts" = "attempts" + 1, "startedAt" = ${now}, "updatedAt" = ${now}
     WHERE "id" = (
             SELECT "id" FROM "Job"
              WHERE "status" = 'QUEUED' AND "runAt" <= ${now}
                AND ("serialKey" IS NULL OR "serialKey" NOT IN (
                      SELECT "serialKey" FROM "Job" WHERE "status" = 'RUNNING' AND "serialKey" IS NOT NULL))
              ORDER BY "priority", "runAt"
              LIMIT 1)
       AND "status" = 'QUEUED'
    RETURNING *`;
  const row = rows[0];
  return row ? toClaimedJob(row) : null;
}

function toDate(value: unknown, column: string): Date {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new Error(`claim-job: column ${column} is not a date: ${String(value)}`);
  return date;
}

function toDateOrNull(value: unknown, column: string): Date | null {
  return value === null || value === undefined ? null : toDate(value, column);
}

function toInt(value: unknown, column: string): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`claim-job: column ${column} is not an integer: ${String(value)}`);
}

function toStr(value: unknown, column: string): string {
  if (typeof value !== 'string') throw new Error(`claim-job: column ${column} is not text`);
  return value;
}

function toStrOrNull(value: unknown, column: string): string | null {
  return value === null || value === undefined ? null : toStr(value, column);
}

function toBool(value: unknown, column: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 0n) return false;
  if (value === 1 || value === 1n) return true;
  throw new Error(`claim-job: column ${column} is not a boolean: ${String(value)}`);
}

function toJson(value: unknown): unknown {
  return typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
}

const JOB_STATUSES = new Set<string>(['QUEUED', 'RUNNING', 'SUCCEEDED', 'DEAD', 'CANCELLED']);

function toClaimedJob(r: RawRow): ClaimedJob {
  const status = toStr(r.status, 'status');
  if (!JOB_STATUSES.has(status)) throw new Error(`claim-job: unknown status ${status}`);
  return {
    id: toStr(r.id, 'id'),
    workspaceId: toStrOrNull(r.workspaceId, 'workspaceId'),
    type: toStr(r.type, 'type'),
    payload: toJson(r.payload),
    payloadVersion: toInt(r.payloadVersion, 'payloadVersion'),
    status: status as JobStatus,
    priority: toInt(r.priority, 'priority'),
    runAt: toDate(r.runAt, 'runAt'),
    attempts: toInt(r.attempts, 'attempts'),
    maxAttempts: toInt(r.maxAttempts, 'maxAttempts'),
    claimToken: toStr(r.claimToken, 'claimToken'),
    leaseUntil: toDate(r.leaseUntil, 'leaseUntil'),
    startedAt: toDate(r.startedAt, 'startedAt'),
    serialKey: toStrOrNull(r.serialKey, 'serialKey'),
    idempotencyKey: toStr(r.idempotencyKey, 'idempotencyKey'),
    cancelRequestedAt: toDateOrNull(r.cancelRequestedAt, 'cancelRequestedAt'),
    retrySafe: toBool(r.retrySafe, 'retrySafe'),
    correlationId: toStr(r.correlationId, 'correlationId'),
    causationId: toStrOrNull(r.causationId, 'causationId'),
    createdAt: toDate(r.createdAt, 'createdAt'),
    updatedAt: toDate(r.updatedAt, 'updatedAt'),
  };
}
