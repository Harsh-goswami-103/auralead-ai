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
 * Email keeps the same shape: DEMO gets the demo transport; LIVE gets the Resend transport (T33)
 * when the Resend integration is usable, else the SMTP transport, else INTEGRATION_NOT_CONFIGURED
 * or CREDENTIAL_UNREADABLE (ADR-100).
 *
 * Meta (T35): `metaLeadsClient` (META_GRAPH_VERSION) and `metaMarketingClient`
 * (META_MARKETING_VERSION, needs the ad account ID) are LIVE only; DEMO is refused, and the Meta
 * services use the demo adapter's simulated values there without any client.
 */
import type { Clock } from '@/lib/clock';
import { getConfig } from '@/lib/config';
import type { IntegrationKind, IntegrationStatus } from '@/lib/domain/enums';
import { createDemoEmailTransport } from './email/demo';
import type { EmailTransport } from './email/port';
import { createResendClient, createResendTransport, type ResendClient, type ResendHttp } from './email/resend';
import { checkSmtpConnection, createSmtpTransport, SMTP_PORTS, type SmtpCheckResult, type SmtpSeams } from './email/smtp';
import { checkAnthropicConnection, checkOpenAiConnection, type AiCheckResult } from './ai/connection-check';
import type { AiTransport } from './ai/port';
import { createCloudApiClient, createCloudApiTransport, GRAPH_ID_RE, GRAPH_VERSION_RE, type CloudApiClient, type GraphHttp } from './whatsapp/cloud-api';
import { adAccountDigits, createMetaLeadsClient, createMetaMarketingClient, type MetaLeadsClient, type MetaMarketingClient } from './meta/graph';
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

// ---- Email (T33: Resend and SMTP) --------------------------------------------------------------------

/** Test seams for the live email adapters (a scripted Resend API, a local SMTP server). */
export type EmailSeams = { resend?: { http?: ResendHttp; baseUrl?: string }; smtp?: SmtpSeams };

export type EmailResolveInput = {
  mode: ProcessMode;
  workspaceMode: 'DEMO' | 'LIVE';
  /** LIVE: the workspace's EMAIL_RESEND and EMAIL_SMTP integrations, decrypted by the caller. */
  integrations: readonly IntegrationUse[];
  clock: Clock;
  storageDir: string;
  seams?: EmailSeams;
};

/** LIVE preference when both are usable (ADR-100): Resend first, then SMTP. */
export const EMAIL_KIND_PREFERENCE: readonly IntegrationKind[] = ['EMAIL_RESEND', 'EMAIL_SMTP'];

export function resolveEmailTransport(input: EmailResolveInput): Resolution<EmailTransport> {
  if (!modeMatches(input.mode, input.workspaceMode)) return problem('MODE_MISMATCH', 'the workspace belongs to the other mode', null);
  if (input.mode === 'demo') return { ok: true, value: createDemoEmailTransport(createFileDemoOutbox(demoOutboxDir(input.storageDir)), input.clock) };
  return liveEmailTransport(input);
}

/**
 * LIVE only: the Resend transport when the Resend integration is CONNECTED or DEGRADED, else the
 * SMTP transport when that one is; the chosen integration must have readable credentials and a
 * complete configuration, otherwise its typed problem (there is no second choice within one
 * resolution, and never a demo transport).
 */
function liveEmailTransport(input: EmailResolveInput): Resolution<EmailTransport> {
  const chosen = EMAIL_KIND_PREFERENCE.map((kind) => input.integrations.find((i) => i.kind === kind)).find((i): i is IntegrationUse => i !== undefined && SEND_USABLE_STATUSES.has(i.status));
  if (!chosen) return problem('INTEGRATION_NOT_CONFIGURED', 'no connected email integration is stored', input.integrations[0]?.id ?? null);
  if (chosen.kind === 'EMAIL_RESEND') {
    const options = liveResendOptions(chosen, input.clock, input.seams);
    return options.ok ? { ok: true, value: createResendTransport(options.value) } : options;
  }
  const options = liveSmtpOptions(chosen, input.clock, input.seams);
  return options.ok ? { ok: true, value: createSmtpTransport(options.value) } : options;
}

const EMAIL_ADDRESS_RE = /^[^\s@<>",;]{1,64}@([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,63})$/;

type ResendTransportOptions = Parameters<typeof createResendTransport>[0];
type SmtpTransportOptions = Parameters<typeof createSmtpTransport>[0];

/** LIVE only: the API key, the sending domain and a from address at that domain. */
function liveResendOptions(integration: IntegrationUse, clock: Clock, seams: EmailSeams | undefined): Resolution<ResendTransportOptions> {
  if (integration.kind !== 'EMAIL_RESEND') return problem('INTEGRATION_NOT_CONFIGURED', 'not a Resend integration', integration.id);
  if (integration.credentials.state === 'unreadable') return problem('CREDENTIAL_UNREADABLE', 'the stored Resend API key does not decrypt', integration.id, integration.credentials.field);
  if (integration.credentials.state === 'missing') return problem('INTEGRATION_NOT_CONFIGURED', 'the Resend API key is not saved', integration.id, integration.credentials.fields[0]);
  const apiKey = integration.credentials.values.apiKey;
  if (!apiKey) return problem('INTEGRATION_NOT_CONFIGURED', 'the Resend API key is not saved', integration.id, 'apiKey');
  const fromDomain = configString(integration.config, 'fromDomain')?.toLowerCase() ?? null;
  const fromAddress = configString(integration.config, 'fromAddress');
  if (!fromDomain) return problem('INTEGRATION_NOT_CONFIGURED', 'the sending domain is not set', integration.id);
  const match = fromAddress ? EMAIL_ADDRESS_RE.exec(fromAddress) : null;
  if (!fromAddress || !match) return problem('INTEGRATION_NOT_CONFIGURED', 'the from address is not set', integration.id);
  if (match[1]!.toLowerCase() !== fromDomain) return problem('INTEGRATION_NOT_CONFIGURED', 'the from address is not at the sending domain', integration.id);
  return {
    ok: true,
    value: { mode: 'live', apiKey, fromAddress, clock, ...(seams?.resend?.http ? { http: seams.resend.http } : {}), ...(seams?.resend?.baseUrl ? { baseUrl: seams.resend.baseUrl } : {}) },
  };
}

/** LIVE only: host, an SMTP port, username, password and the from address. */
function liveSmtpOptions(integration: IntegrationUse, clock: Clock, seams: EmailSeams | undefined): Resolution<SmtpTransportOptions> {
  if (integration.kind !== 'EMAIL_SMTP') return problem('INTEGRATION_NOT_CONFIGURED', 'not an SMTP integration', integration.id);
  if (integration.credentials.state === 'unreadable') return problem('CREDENTIAL_UNREADABLE', 'the stored SMTP password does not decrypt', integration.id, integration.credentials.field);
  if (integration.credentials.state === 'missing') return problem('INTEGRATION_NOT_CONFIGURED', 'the SMTP password is not saved', integration.id, integration.credentials.fields[0]);
  const password = integration.credentials.values.password;
  if (!password) return problem('INTEGRATION_NOT_CONFIGURED', 'the SMTP password is not saved', integration.id, 'password');
  const host = configString(integration.config, 'host');
  const portRaw = configString(integration.config, 'port');
  const username = configString(integration.config, 'username');
  const fromAddress = configString(integration.config, 'fromAddress');
  const port = portRaw !== null && /^\d{1,5}$/.test(portRaw) ? Number(portRaw) : NaN;
  if (!host || !username) return problem('INTEGRATION_NOT_CONFIGURED', 'the SMTP host or username is not set', integration.id);
  if (!SMTP_PORTS.includes(port)) return problem('INTEGRATION_NOT_CONFIGURED', 'the SMTP port is not 25, 465, 587 or 2525', integration.id);
  if (!fromAddress || !EMAIL_ADDRESS_RE.test(fromAddress)) return problem('INTEGRATION_NOT_CONFIGURED', 'the from address is not set', integration.id);
  return { ok: true, value: { mode: 'live', host, port, username, password, fromAddress, clock, ...(seams?.smtp ? { seams: seams.smtp } : {}) } };
}

/** A Resend API client for the connection test on a configured integration of any checkable status; never in DEMO. */
export function resendApiClient(input: { mode: ProcessMode; integration: IntegrationUse | null; clock: Clock; seams?: EmailSeams }): Resolution<ResendClient & { fromDomain: string }> {
  if (input.mode !== 'live') return problem('MODE_MISMATCH', 'DEMO never contacts a provider', input.integration?.id ?? null);
  return liveResendClient(input);
}

function liveResendClient(input: { integration: IntegrationUse | null; clock: Clock; seams?: EmailSeams }): Resolution<ResendClient & { fromDomain: string }> {
  if (!input.integration) return problem('INTEGRATION_NOT_CONFIGURED', 'no Resend integration is stored', null);
  if (input.integration.credentials.state !== 'unreadable' && !CHECKABLE_STATUSES.has(input.integration.status)) {
    return problem('INTEGRATION_NOT_CONFIGURED', `the Resend integration is ${input.integration.status}`, input.integration.id);
  }
  const options = liveResendOptions(input.integration, input.clock, input.seams);
  if (!options.ok) return options;
  const fromDomain = configString(input.integration.config, 'fromDomain')!.toLowerCase();
  return { ok: true, value: { ...createResendClient(options.value), fromDomain } };
}

export type SmtpCheck = () => Promise<SmtpCheckResult>;

/** The SMTP connection test (connect, TLS, AUTH, QUIT) for a configured integration; never in DEMO. */
export function smtpConnectionCheck(input: { mode: ProcessMode; integration: IntegrationUse | null; clock: Clock; seams?: EmailSeams }): Resolution<SmtpCheck> {
  if (input.mode !== 'live') return problem('MODE_MISMATCH', 'DEMO never contacts a provider', input.integration?.id ?? null);
  return liveSmtpCheck(input);
}

function liveSmtpCheck(input: { integration: IntegrationUse | null; clock: Clock; seams?: EmailSeams }): Resolution<SmtpCheck> {
  if (!input.integration) return problem('INTEGRATION_NOT_CONFIGURED', 'no SMTP integration is stored', null);
  if (input.integration.credentials.state !== 'unreadable' && !CHECKABLE_STATUSES.has(input.integration.status)) {
    return problem('INTEGRATION_NOT_CONFIGURED', `the SMTP integration is ${input.integration.status}`, input.integration.id);
  }
  const options = liveSmtpOptions(input.integration, input.clock, input.seams);
  if (!options.ok) return options;
  return { ok: true, value: () => checkSmtpConnection(options.value) };
}

// ---- Meta Lead Ads and Marketing API (T35) ------------------------------------------------------------

export type MetaClientInput = {
  mode: ProcessMode;
  /** The workspace's META_ADS integration with its credentials decrypted (null when none is stored). */
  integration: IntegrationUse | null;
  /** META_GRAPH_VERSION (leads, Page) and META_MARKETING_VERSION (ad account, campaigns); null means not configured. */
  graphVersion: string | null;
  marketingVersion: string | null;
  clock: Clock;
  /** Statuses the operation may run on: reads take any checkable status, a campaign change only a verified one. */
  usable: ReadonlySet<IntegrationStatus>;
  graph?: GraphSeams;
};

/** A Graph client for the Page and its leads (META_GRAPH_VERSION). DEMO never gets one. */
export function metaLeadsClient(input: MetaClientInput): Resolution<MetaLeadsClient> {
  if (input.mode !== 'live') return problem('MODE_MISMATCH', 'DEMO never contacts a provider', input.integration?.id ?? null);
  return liveMetaLeadsClient(input);
}

/** A Marketing API client for the configured ad account (META_MARKETING_VERSION). DEMO never gets one. */
export function metaMarketingClient(input: MetaClientInput): Resolution<MetaMarketingClient> {
  if (input.mode !== 'live') return problem('MODE_MISMATCH', 'DEMO never contacts a provider', input.integration?.id ?? null);
  return liveMetaMarketingClient(input);
}

/** LIVE only: the access token of a usable META_ADS integration, or a typed problem. */
function liveMetaToken(input: MetaClientInput): Resolution<{ integration: IntegrationUse; accessToken: string }> {
  const integration = input.integration;
  if (!integration || integration.kind !== 'META_ADS') return problem('INTEGRATION_NOT_CONFIGURED', 'no Meta Lead Ads integration is stored', null);
  if (integration.credentials.state === 'unreadable') return problem('CREDENTIAL_UNREADABLE', 'the stored access token does not decrypt', integration.id, integration.credentials.field);
  if (!input.usable.has(integration.status)) return problem('INTEGRATION_NOT_CONFIGURED', `the Meta Lead Ads integration is ${integration.status}`, integration.id);
  const accessToken = integration.credentials.state === 'ok' ? integration.credentials.values.accessToken : undefined;
  if (!accessToken) return problem('INTEGRATION_NOT_CONFIGURED', 'the access token is not saved', integration.id, 'accessToken');
  return { ok: true, value: { integration, accessToken } };
}

function liveMetaLeadsClient(input: MetaClientInput): Resolution<MetaLeadsClient> {
  const token = liveMetaToken(input);
  if (!token.ok) return token;
  const id = token.value.integration.id;
  if (!input.graphVersion || !GRAPH_VERSION_RE.test(input.graphVersion)) return problem('INTEGRATION_NOT_CONFIGURED', 'META_GRAPH_VERSION is not configured on the server', id);
  return {
    ok: true,
    value: createMetaLeadsClient({ mode: 'live', version: input.graphVersion, accessToken: token.value.accessToken, clock: input.clock, ...(input.graph?.http ? { http: input.graph.http } : {}), ...(input.graph?.baseUrl ? { baseUrl: input.graph.baseUrl } : {}) }),
  };
}

function liveMetaMarketingClient(input: MetaClientInput): Resolution<MetaMarketingClient> {
  const token = liveMetaToken(input);
  if (!token.ok) return token;
  const id = token.value.integration.id;
  const adAccount = configString(token.value.integration.config, 'adAccountId');
  const digits = adAccount ? adAccountDigits(adAccount) : null;
  if (!digits) return problem('INTEGRATION_NOT_CONFIGURED', 'the ad account ID is not set', id, 'adAccountId');
  if (!input.marketingVersion || !GRAPH_VERSION_RE.test(input.marketingVersion)) return problem('INTEGRATION_NOT_CONFIGURED', 'META_MARKETING_VERSION is not configured on the server', id);
  return {
    ok: true,
    value: createMetaMarketingClient({
      mode: 'live',
      version: input.marketingVersion,
      accessToken: token.value.accessToken,
      adAccountId: digits,
      clock: input.clock,
      ...(input.graph?.http ? { http: input.graph.http } : {}),
      ...(input.graph?.baseUrl ? { baseUrl: input.graph.baseUrl } : {}),
    }),
  };
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
