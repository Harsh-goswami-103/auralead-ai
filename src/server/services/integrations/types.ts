/**
 * Seams of the Integration center (T28) for the live adapters (T32-T36).
 *
 * T28 owns the read and masking surface, the DEMO behaviour and the dispatch of a connection test
 * or template sync. Everything that talks to a provider is plugged in by registering an
 * implementation in `live-adapters.ts`:
 *
 * - `LiveConnectionTester` (T32 framework; one per IntegrationKind as the adapters land): runs the
 *   provider check for a stored integration (it decrypts its own credentials through the key ring,
 *   AAD `workspaceId|integrationId|field`, A33) and returns the outcome. `testIntegrationConnection`
 *   persists that outcome (status, lastCheckedAt, redacted error, verifiedAt on CONNECTED) and
 *   audits it. It is called outside any transaction (no network in a transaction, plan §3).
 * - `LiveTemplateSync` (T32): fetches the WABA's templates and stores them with raw status and
 *   category strings (ADR-17, P12), returning the counts.
 *
 * Nothing here ever decrypts or returns a secret: the integration handed to an adapter carries no
 * ciphertext, and every read model exposes credentials only as "saved + last four".
 */
import type { IntegrationKind, IntegrationStatus } from '@/lib/domain/enums';
import type { AppCtx } from '@/server/auth/context';

/** A stored integration as an adapter receives it: identity, state and non-secret config only. */
export type IntegrationForAdapter = {
  id: string;
  workspaceId: string;
  kind: IntegrationKind;
  status: IntegrationStatus;
  config: Record<string, unknown>;
};

/** The statuses a live check may set. SIMULATED and NOT_CONFIGURED are never a live outcome. */
export type LiveTestStatus = Extract<IntegrationStatus, 'CONNECTED' | 'DEGRADED' | 'ERROR' | 'REVOKED' | 'CONFIGURED_UNVERIFIED'>;

export type LiveTestOutcome = {
  status: LiveTestStatus;
  /** Stable code for the failure (e.g. PROVIDER_AUTH, PERMISSION_MISSING); null when it passed. */
  errorCode?: string | null;
  /** Provider message; stored only after `redactText`. */
  errorMessage?: string | null;
};

export type LiveConnectionTester = (ctx: AppCtx, integration: IntegrationForAdapter) => Promise<LiveTestOutcome>;

export type LiveTesters = Partial<Record<IntegrationKind, LiveConnectionTester>>;

export type TemplateSyncResult = {
  integrationId: string;
  simulated: boolean;
  created: number;
  existing: number;
  updated: number;
};

export type LiveTemplateSync = (ctx: AppCtx, integration: IntegrationForAdapter) => Promise<TemplateSyncResult>;
