/**
 * Request context types (plan §4.1). The builders live in src/server/auth/context.ts (T06);
 * the types live here so pure modules can accept a context without importing the server. The
 * DB handle is a type parameter because src/lib never imports the DB layer: the server
 * instantiates `Ctx<ScopedDb>`.
 */
import type { Clock } from '../clock';
import type { Capability, GlobalRole } from './enums';

export type CtxKind = 'user' | 'job' | 'system' | 'public' | 'webhook';
export type CtxMode = 'demo' | 'live';

export type Actor = {
  userId: string;
  role: GlobalRole;
  isDemo: boolean;
};

export type Ctx<TDb = unknown> = {
  kind: CtxKind;
  /** From x-request-id or generated; stored on Job, AuditEvent and JobAttempt. */
  correlationId: string;
  /** Parent job or request. */
  causationId?: string;
  /** From boot config, never from a cookie or query. */
  mode: CtxMode;
  actor: Actor | null;
  /** Resolved server-side only; browser-supplied workspace ids are ignored. */
  workspaceId: string | null;
  capabilities: ReadonlySet<Capability>;
  /** The actor's discount cap (owner: the workspace hard limit). */
  maxDiscountBps: number | null;
  /** Super admin drilldown only, after the audit event is written. */
  elevated?: { reason: string; auditEventId: string };
  clock: Clock;
  db: TDb;
};
