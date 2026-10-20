/**
 * The adapter registry: the one mode switch for provider adapters (plan §3 "registry.ts is the only
 * mode switch", §4.2, ADR-04; T32). Besides `src/lib/config.ts`, this is the only module allowed to
 * know the process mode from configuration (`processMode()`); everything else uses `ctx.mode`.
 *
 * Callers load the workspace's Integration and decrypt its credentials themselves, outside any
 * transaction (services/integrations/credentials.ts), and hand the result in. The registry is pure
 * apart from building clients: it never reads the database and never decrypts.
 *
 *  - DEMO: the recording demo transports (zero outbound). Live clients are refused.
 *  - LIVE: the provider adapter when the integration is usable; otherwise a typed problem:
 *    INTEGRATION_NOT_CONFIGURED (nothing stored, not verified, missing config, no Graph version)
 *    or CREDENTIAL_UNREADABLE (a stored secret no longer decrypts). The dispatch handler turns
 *    either into the existing NOT_CONFIGURED skip. LIVE never falls back to a demo transport: the
 *    `live*` functions below never reference one (pinned by tests/unit/arch/registry-live.test.ts).
 *  - A workspace whose stored mode differs from the process mode is refused (defense in depth).
 *
 * Email keeps the same shape: DEMO gets the demo transport; LIVE has no live email transport until
 * T33 adds Resend and SMTP in `liveEmailTransport`, so it answers INTEGRATION_NOT_CONFIGURED.
 */
import type { Clock } from '@/lib/clock';
import { getConfig } from '@/lib/config';
import type { IntegrationKind, IntegrationStatus } from '@/lib/domain/enums';
import { createDemoEmailTransport } from './email/demo';
import type { EmailTransport } from './email/port';
import { checkAnthropicConnection, checkOpenAiConnection, type AiCheckResult } from './ai/connection-check';
import type { AiTransport } from './ai/port';
import { createCloudApiClient, createCloudApiTransport, GRAPH_ID_RE, GRAPH_VERSION_RE, type CloudApiClient, type GraphHttp } from './whatsapp/cloud-api';
import { createDemoWhatsAppTransport, createFileDemoOutbox, demoOutboxDir } from './whatsapp/demo';
import type { WhatsAppTransport } from './whatsapp/port';

export type ProcessMode = 'demo' | 'live';

/** The process mode from the validated boot configuration (APP_MODE, read only through config.ts). */
export function processMode(): ProcessMode {
  return getConfig().mode;
}

/** A stored secret as the caller found it: decrypted, absent, or present but no longer readable. */
export type CredentialState =
  | { state: 'ok'; values: Readonly<Record<string, string>> }
  | { state: 'missing'; fields: readonly string[] }
  | { state: 'unreadable'; field: string };

/** A workspace's integration with its credentials already decrypted by the caller. */
export type IntegrationUse = {
  id: string;
  kind: IntegrationKind;
  status: IntegrationStatus;
  config: Readonly<Record<string, unknown>>;
  credentials: CredentialState;
};

export type ProblemCode = 'INTEGRATION_NOT_CONFIGURED' | 'CREDENTIAL_UNREADABLE' | 'MODE_MISMATCH';

export type Problem = { ok: false; code: ProblemCode; reason: string; integrationId: string | null; field?: string };

export type Resolution<T> = { ok: true; value: T } | Problem;

/** Statuses whose integration may send (eligibility additionally requires CONNECTED). */
export const SEND_USABLE_STATUSES: ReadonlySet<IntegrationStatus> = new Set(['CONNECTED', 'DEGRADED']);
/** Statuses a live check or read (test, sync, quality) may run on. */
export const CHECKABLE_STATUSES: ReadonlySet<IntegrationStatus> = new Set(['CONFIGURED_UNVERIFIED', 'VERIFYING', 'CONNECTED', 'DEGRADED', 'ERROR']);

export type GraphSeams = { http?: GraphHttp; baseUrl?: string };

function problem(code: ProblemCode, reason: string, integrationId: string | null, field?: string): Problem {
  return { ok: false, code, reason, integrationId, ...(field ? { field } : {}) };
}

function modeMatches(mode: ProcessMode, workspaceMode: 'DEMO' | 'LIVE'): boolean {
  return workspaceMode === (mode === 'demo' ? 'DEMO' : 'LIVE');
}

function configString(config: Readonly<Record<string, unknown>>, key: string): string | null {
  const v = config[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

// ---- WhatsApp ------------------------------------------------------------------------------------

export type WhatsAppResolveInput = {
  mode: ProcessMode;
  workspaceMode: 'DEMO' | 'LIVE';
  /** LIVE: the workspace's WHATSAPP_CLOUD integration (null when none is stored). Ignored in DEMO. */
  integration: IntegrationUse | null;
  /** META_GRAPH_VERSION; null means not configured (never a guessed default). */
  graphVersion: string | null;
  clock: Clock;
  /** DEMO: where the demo outbox lives. */
  storageDir: string;
  graph?: GraphSeams;
};

export function resolveWhatsAppTransport(input: WhatsAppResolveInput): Resolution<WhatsAppTransport> {
  if (!modeMatches(input.mode, input.workspaceMode)) return problem('MODE_MISMATCH', 'the workspace belongs to the other mode', input.integration?.id ?? null);
  if (input.mode === 'demo') return { ok: true, value: createDemoWhatsAppTransport(createFileDemoOutbox(demoOutboxDir(input.storageDir)), input.clock) };
  return liveWhatsAppTransport(input);
}

/** LIVE only: the Cloud API transport or a typed problem. Never a demo transport. */
function liveWhatsAppTransport(input: WhatsAppResolveInput): Resolution<WhatsAppTransport> {
  const client = liveCloudApiOptions(input, SEND_USABLE_STATUSES);
  if (!client.ok) return client;
  return { ok: true, value: createCloudApiTransport(client.value) };
}

type CloudOptions = Parameters<typeof createCloudApiTransport>[0];

function liveCloudApiOptions(input: Pick<WhatsAppResolveInput, 'integration' | 'graphVersion' | 'clock' | 'graph'>, usable: ReadonlySet<IntegrationStatus>): Resolution<CloudOptions> {
  const integration = input.integration;
  if (!integration || integration.kind !== 'WHATSAPP_CLOUD') return problem('INTEGRATION_NOT_CONFIGURED', 'no WhatsApp integration is stored', null);
  // An unreadable secret is named as such whatever the status (it is what the person has to fix).
  if (integration.credentials.state === 'unreadable') return problem('CREDENTIAL_UNREADABLE', 'the stored access token does not decrypt', integration.id, integration.credentials.field);
  if (!usable.has(integration.status)) return problem('INTEGRATION_NOT_CONFIGURED', `the WhatsApp integration is ${integration.status}`, integration.id);
  if (integration.credentials.state === 'missing') return problem('INTEGRATION_NOT_CONFIGURED', 'the access token is not saved', integration.id, integration.credentials.fields[0]);
  const accessToken = integration.credentials.values.accessToken;
  if (!accessToken) return problem('INTEGRATION_NOT_CONFIGURED', 'the access token is not saved', integration.id, 'accessToken');
  const phoneNumberId = configString(integration.config, 'phoneNumberId');
  if (!phoneNumberId || !GRAPH_ID_RE.test(phoneNumberId)) return problem('INTEGRATION_NOT_CONFIGURED', 'the phone number ID is not set', integration.id);
  const wabaRaw = configString(integration.config, 'wabaId');
  const wabaId = wabaRaw && GRAPH_ID_RE.test(wabaRaw) ? wabaRaw : null;
  if (!input.graphVersion || !GRAPH_VERSION_RE.test(input.graphVersion)) return problem('INTEGRATION_NOT_CONFIGURED', 'META_GRAPH_VERSION is not configured on the server', integration.id);
  return {
    ok: true,
    value: { mode: 'live', graphVersion: input.graphVersion, phoneNumberId, wabaId, accessToken, clock: input.clock, ...(input.graph?.http ? { http: input.graph.http } : {}), ...(input.graph?.baseUrl ? { baseUrl: input.graph.baseUrl } : {}) },
  };
}

/**
 * A Graph client for live reads (connection test, template sync, quality and limits) on a
 * configured integration of any checkable status. DEMO never gets one: a DEMO integration never
 * reaches a provider.
 */
export function whatsAppGraphClient(input: { mode: ProcessMode; integration: IntegrationUse | null; graphVersion: string | null; clock: Clock; graph?: GraphSeams }): Resolution<CloudApiClient> {
  if (input.mode !== 'live') return problem('MODE_MISMATCH', 'DEMO never contacts a provider', input.integration?.id ?? null);
  return liveGraphClient(input);
}

function liveGraphClient(input: { integration: IntegrationUse | null; graphVersion: string | null; clock: Clock; graph?: GraphSeams }): Resolution<CloudApiClient> {
  const options = liveCloudApiOptions(input, CHECKABLE_STATUSES);
  if (!options.ok) return options;
  return { ok: true, value: createCloudApiClient(options.value) };
}

// ---- Email (T33 adds the live transports) ----------------------------------------------------------

export type EmailResolveInput = {
  mode: ProcessMode;
  workspaceMode: 'DEMO' | 'LIVE';
  /** LIVE: the workspace's EMAIL_RESEND and EMAIL_SMTP integrations, decrypted by the caller. */
  integrations: readonly IntegrationUse[];
  clock: Clock;
  storageDir: string;
};

export function resolveEmailTransport(input: EmailResolveInput): Resolution<EmailTransport> {
  if (!modeMatches(input.mode, input.workspaceMode)) return problem('MODE_MISMATCH', 'the workspace belongs to the other mode', null);
  if (input.mode === 'demo') return { ok: true, value: createDemoEmailTransport(createFileDemoOutbox(demoOutboxDir(input.storageDir)), input.clock) };
  return liveEmailTransport(input);
}

/** LIVE only. T33 adds Resend and SMTP here; until then no live email transport exists. Never a demo transport. */
function liveEmailTransport(input: EmailResolveInput): Resolution<EmailTransport> {
  const usable = input.integrations.find((i) => SEND_USABLE_STATUSES.has(i.status));
  if (!usable) return problem('INTEGRATION_NOT_CONFIGURED', 'no connected email integration is stored', input.integrations[0]?.id ?? null);
  if (usable.credentials.state === 'unreadable') return problem('CREDENTIAL_UNREADABLE', 'a stored email credential does not decrypt', usable.id, usable.credentials.field);
  return problem('INTEGRATION_NOT_CONFIGURED', 'no live email transport is available in this version', usable.id);
}

// ---- AI connection checks ---------------------------------------------------------------------------

export type AiCheck = () => Promise<AiCheckResult>;

/** The live Models API check for an AI integration; DEMO never gets one. */
export function aiConnectionCheck(input: { mode: ProcessMode; kind: 'AI_ANTHROPIC' | 'AI_OPENAI'; apiKey: string; modelId: string | null; transport?: AiTransport; baseURL?: string }): Resolution<AiCheck> {
  if (input.mode !== 'live') return problem('MODE_MISMATCH', 'DEMO never contacts a provider', null);
  return liveAiCheck(input);
}

function liveAiCheck(input: { kind: 'AI_ANTHROPIC' | 'AI_OPENAI'; apiKey: string; modelId: string | null; transport?: AiTransport; baseURL?: string }): Resolution<AiCheck> {
  const args = { apiKey: input.apiKey, modelId: input.modelId, ...input.transport, ...(input.baseURL ? { baseURL: input.baseURL } : {}) };
  return { ok: true, value: input.kind === 'AI_ANTHROPIC' ? () => checkAnthropicConnection(args) : () => checkOpenAiConnection(args) };
}
