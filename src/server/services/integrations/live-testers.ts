/**
 * Live connection testers (T32; ADR-80 seam 1, PRD "never silently fall back to simulated
 * success"). Each one decrypts its own credentials (AAD `workspaceId|integrationId|field`), builds
 * its client through the adapter registry and makes a minimal authenticated read; the outcome is
 * stored by `persistLiveTestOutcome`. A tester never reports CONNECTED without a real provider
 * answer that matches the configuration:
 *
 *  - WhatsApp Cloud API: GET /<phone number id>?fields=id,display_phone_number,verified_name and,
 *    when a WABA id is set, GET /<waba id>?fields=id,name. Both ids must come back as configured.
 *  - Anthropic and OpenAI: the Models API check in adapters/ai/connection-check.ts.
 *
 * Failure mapping: a rejected token is ERROR PROVIDER_AUTH; a missing permission ERROR
 * PERMISSION_MISSING; an unknown id ERROR CONFIG_INVALID; an unreadable secret ERROR
 * CREDENTIAL_UNREADABLE ("Credential unreadable, re-enter"). Throttling, provider errors and no
 * answer at all say nothing about the credentials: a previously CONNECTED integration becomes
 * DEGRADED, anything else stays CONFIGURED_UNVERIFIED, with the reason stored.
 */
import type { IntegrationKind, IntegrationStatus } from '@/lib/domain/enums';
import { AppError, ProviderAuthError, ProviderPermissionError, ProviderRateLimitedError } from '@/lib/errors';
import type { AiTransport } from '@/server/adapters/ai/port';
import { aiConnectionCheck, whatsAppGraphClient, type EmailSeams, type GraphSeams, type IntegrationUse, type Problem } from '@/server/adapters/registry';
import { classifyGraphReadFailure, describeGraphFailure, type GraphCall } from '@/server/adapters/whatsapp/cloud-api';
import type { AppCtx } from '@/server/auth/context';
import type { KeyRing } from '@/server/security/secrets';
import { loadIntegrationForUse } from './credentials';
import { resendTester, smtpTester } from './email-testers';
import { CREDENTIAL_UNREADABLE_CODE, CREDENTIAL_UNREADABLE_MESSAGE, type LiveConnectionTester, type LiveTesters, type LiveTestOutcome, type LiveTestStatus } from './types';

export type LiveAdapterDeps = {
  keyRing: KeyRing | null;
  /** META_GRAPH_VERSION; null means WhatsApp is not configurable on this server. */
  graphVersion: string | null;
  /** Test seams: a scripted Graph transport or a local base URL; an injected fetch for the AI SDKs. */
  graph?: GraphSeams;
  aiTransport?: AiTransport;
  aiBaseUrl?: Partial<Record<'AI_ANTHROPIC' | 'AI_OPENAI', string>>;
  /** T33 test seams: a scripted Resend API, a local SMTP server. */
  email?: EmailSeams;
};

/** Throttling or no answer: says nothing about the credentials. */
export function inconclusive(previous: IntegrationStatus): LiveTestStatus {
  return previous === 'CONNECTED' || previous === 'DEGRADED' ? 'DEGRADED' : 'CONFIGURED_UNVERIFIED';
}

function unreadable(): LiveTestOutcome {
  return { status: 'ERROR', errorCode: CREDENTIAL_UNREADABLE_CODE, errorMessage: CREDENTIAL_UNREADABLE_MESSAGE };
}

/** The outcome for an integration the registry would not build a client for. */
export function problemOutcome(p: Problem, previous: IntegrationStatus): LiveTestOutcome {
  if (p.code === 'CREDENTIAL_UNREADABLE') return unreadable();
  return { status: previous === 'ERROR' ? 'ERROR' : 'CONFIGURED_UNVERIFIED', errorCode: 'INTEGRATION_NOT_CONFIGURED', errorMessage: p.reason };
}

/** A failed Graph read as a test outcome. */
export function graphFailureOutcome(call: Extract<GraphCall<unknown>, { ok: false }>, previous: IntegrationStatus): LiveTestOutcome {
  const detail = describeGraphFailure(call);
  switch (classifyGraphReadFailure(call)) {
    case 'auth':
      return { status: 'ERROR', errorCode: 'PROVIDER_AUTH', errorMessage: `Meta rejected the access token (expired or revoked); enter a new one. ${detail}` };
    case 'permission':
      return { status: 'ERROR', errorCode: 'PERMISSION_MISSING', errorMessage: `The token lacks a permission (whatsapp_business_messaging, whatsapp_business_management). ${detail}` };
    case 'not-found':
      return { status: 'ERROR', errorCode: 'CONFIG_INVALID', errorMessage: `Meta did not accept the configured ID for this token; check the phone number ID and WhatsApp Business Account ID. ${detail}` };
    case 'rate-limited':
      return { status: inconclusive(previous), errorCode: 'PROVIDER_RATE_LIMITED', errorMessage: detail };
    case 'unavailable':
      return { status: inconclusive(previous), errorCode: 'PROVIDER_UNAVAILABLE', errorMessage: detail };
    case 'unreachable':
      return { status: inconclusive(previous), errorCode: 'PROVIDER_UNREACHABLE', errorMessage: detail };
    case 'rejected':
      return { status: 'ERROR', errorCode: 'PROVIDER_REJECTED', errorMessage: detail };
  }
}

async function loadUse(ctx: AppCtx, kind: IntegrationKind, deps: LiveAdapterDeps): Promise<IntegrationUse | null> {
  return loadIntegrationForUse(ctx.db, kind, deps.keyRing);
}

export function whatsAppTester(deps: LiveAdapterDeps): LiveConnectionTester {
  return async (ctx, integration) => {
    const use = await loadUse(ctx, 'WHATSAPP_CLOUD', deps);
    if (!use) return { status: 'CONFIGURED_UNVERIFIED', errorCode: 'INTEGRATION_NOT_CONFIGURED', errorMessage: 'no WhatsApp integration is stored' };
    // Any checkable status may be tested; the registry refuses unreadable or incomplete ones.
    const client = whatsAppGraphClient({ mode: ctx.mode, integration: use, graphVersion: deps.graphVersion, clock: ctx.clock, graph: deps.graph });
    if (!client.ok) return problemOutcome(client, integration.status);
    const phone = await client.value.getPhoneNumber(['id', 'display_phone_number', 'verified_name']);
    if (!phone.ok) return graphFailureOutcome(phone, integration.status);
    if (String(phone.data.id ?? '') !== client.value.phoneNumberId) {
      return { status: 'ERROR', errorCode: 'CONFIG_INVALID', errorMessage: 'Meta answered for a different phone number ID than the one configured.' };
    }
    if (client.value.wabaId !== null) {
      const waba = await client.value.getWaba(['id', 'name']);
      if (!waba.ok) return graphFailureOutcome(waba, integration.status);
      if (String(waba.data.id ?? '') !== client.value.wabaId) {
        return { status: 'ERROR', errorCode: 'CONFIG_INVALID', errorMessage: 'Meta answered for a different WhatsApp Business Account ID than the one configured.' };
      }
    }
    return { status: 'CONNECTED' };
  };
}

function aiFailureOutcome(error: AppError, previous: IntegrationStatus): LiveTestOutcome {
  if (error.code === 'AI_MODEL_NOT_FOUND') return { status: 'ERROR', errorCode: 'AI_MODEL_NOT_FOUND', errorMessage: error.userMessage };
  if (error instanceof ProviderAuthError) return { status: 'ERROR', errorCode: 'PROVIDER_AUTH', errorMessage: 'The provider rejected the API key; enter a new one.' };
  if (error instanceof ProviderPermissionError) return { status: 'ERROR', errorCode: 'PERMISSION_MISSING', errorMessage: error.message };
  if (error instanceof ProviderRateLimitedError) return { status: inconclusive(previous), errorCode: 'PROVIDER_RATE_LIMITED', errorMessage: error.message };
  if (error.retryable) return { status: inconclusive(previous), errorCode: 'PROVIDER_UNREACHABLE', errorMessage: error.message };
  return { status: 'ERROR', errorCode: 'PROVIDER_REJECTED', errorMessage: error.message };
}

export function aiTester(kind: 'AI_ANTHROPIC' | 'AI_OPENAI', deps: LiveAdapterDeps): LiveConnectionTester {
  return async (ctx, integration) => {
    const use = await loadUse(ctx, kind, deps);
    if (!use) return { status: 'CONFIGURED_UNVERIFIED', errorCode: 'INTEGRATION_NOT_CONFIGURED', errorMessage: 'no AI integration is stored' };
    if (use.credentials.state === 'unreadable') return unreadable();
    if (use.credentials.state === 'missing' || !use.credentials.values.apiKey) return { status: 'CONFIGURED_UNVERIFIED', errorCode: 'INTEGRATION_NOT_CONFIGURED', errorMessage: 'the API key is not saved' };
    const modelId = typeof use.config.modelId === 'string' && use.config.modelId.trim() !== '' ? use.config.modelId.trim() : null;
    const baseURL = deps.aiBaseUrl?.[kind];
    const check = aiConnectionCheck({ mode: ctx.mode, kind, apiKey: use.credentials.values.apiKey, modelId, ...(deps.aiTransport ? { transport: deps.aiTransport } : {}), ...(baseURL ? { baseURL } : {}) });
    if (!check.ok) return problemOutcome(check, integration.status);
    const result = await check.value();
    return result.ok ? { status: 'CONNECTED' } : aiFailureOutcome(result.error, integration.status);
  };
}

/** The testers T32 registers; T33-T36 append theirs in live-adapters.ts. */
export function liveConnectionTesters(deps: LiveAdapterDeps): LiveTesters {
  return {
    WHATSAPP_CLOUD: whatsAppTester(deps),
    AI_ANTHROPIC: aiTester('AI_ANTHROPIC', deps),
    AI_OPENAI: aiTester('AI_OPENAI', deps),
    EMAIL_RESEND: resendTester(deps),
    EMAIL_SMTP: smtpTester(deps),
  };
}
