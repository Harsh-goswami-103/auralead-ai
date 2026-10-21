/**
 * Live connection testers for email (T33; ADR-80 seam 1, ADR-99 outcome rules, ADR-100). Each one
 * decrypts its own credentials, builds its client through the adapter registry and asks the
 * provider a real question; nothing is CONNECTED without a real answer, and no email is sent.
 *
 *  - Resend: `GET /domains` with the API key. CONNECTED when the configured sending domain is in
 *    the list with status `verified`; ERROR CONFIG_INVALID when it is missing or not verified
 *    (the raw status is quoted). A sending-only key answers 401 `restricted_api_key` (third-party
 *    reports; UNVERIFIED): the key is real and may send, so the integration is CONNECTED, and the
 *    domain is checked by the first send (an unverified domain fails PERMANENT then).
 *  - SMTP: connect, TLS (STARTTLS or implicit), AUTH, QUIT. CONNECTED when the login is accepted;
 *    ERROR PROVIDER_AUTH on a 5xx login answer, ERROR SMTP_TLS_FAILED when TLS cannot be set up,
 *    ERROR CONFIG_INVALID for a blocked host or port.
 * A rejected key is ERROR PROVIDER_AUTH; throttling, 5xx and no answer say nothing about the
 * credentials: a CONNECTED integration becomes DEGRADED, anything else stays CONFIGURED_UNVERIFIED.
 */
import { resendApiClient, smtpConnectionCheck } from '@/server/adapters/registry';
import { classifyResendReadFailure, describeResendFailure } from '@/server/adapters/email/resend';
import { loadIntegrationForUse } from './credentials';
import { inconclusive, problemOutcome, type LiveAdapterDeps } from './live-testers';
import type { LiveConnectionTester } from './types';

export function resendTester(deps: LiveAdapterDeps): LiveConnectionTester {
  return async (ctx, integration) => {
    const use = await loadIntegrationForUse(ctx.db, 'EMAIL_RESEND', deps.keyRing);
    if (!use) return { status: 'CONFIGURED_UNVERIFIED', errorCode: 'INTEGRATION_NOT_CONFIGURED', errorMessage: 'no Resend integration is stored' };
    const client = resendApiClient({ mode: ctx.mode, integration: use, clock: ctx.clock, ...(deps.email ? { seams: deps.email } : {}) });
    if (!client.ok) return problemOutcome(client, integration.status);
    const res = await client.value.listDomains();
    if (!res.ok) {
      const detail = describeResendFailure(res);
      switch (classifyResendReadFailure(res)) {
        case 'sending-only':
          return { status: 'CONNECTED' };
        case 'auth':
          return { status: 'ERROR', errorCode: 'PROVIDER_AUTH', errorMessage: `Resend rejected the API key; enter a new one. ${detail}` };
        case 'permission':
          return { status: 'ERROR', errorCode: 'PERMISSION_MISSING', errorMessage: detail };
        case 'rate-limited':
          return { status: inconclusive(integration.status), errorCode: 'PROVIDER_RATE_LIMITED', errorMessage: detail };
        case 'unavailable':
          return { status: inconclusive(integration.status), errorCode: 'PROVIDER_UNAVAILABLE', errorMessage: detail };
        case 'unreachable':
          return { status: inconclusive(integration.status), errorCode: 'PROVIDER_UNREACHABLE', errorMessage: detail };
        case 'rejected':
          return { status: 'ERROR', errorCode: 'PROVIDER_REJECTED', errorMessage: detail };
      }
    }
    const domain = res.data.domains.find((d) => d.name.toLowerCase() === client.value.fromDomain);
    if (!domain) {
      return { status: 'ERROR', errorCode: 'CONFIG_INVALID', errorMessage: `The sending domain ${client.value.fromDomain} is not in this Resend account${res.data.hasMore ? "'s first page of domains" : ''}.` };
    }
    if (domain.status !== 'verified') {
      return { status: 'ERROR', errorCode: 'CONFIG_INVALID', errorMessage: `The sending domain ${client.value.fromDomain} is not verified in Resend (status: ${domain.status || 'unknown'}).` };
    }
    return { status: 'CONNECTED' };
  };
}

export function smtpTester(deps: LiveAdapterDeps): LiveConnectionTester {
  return async (ctx, integration) => {
    const use = await loadIntegrationForUse(ctx.db, 'EMAIL_SMTP', deps.keyRing);
    if (!use) return { status: 'CONFIGURED_UNVERIFIED', errorCode: 'INTEGRATION_NOT_CONFIGURED', errorMessage: 'no SMTP integration is stored' };
    const check = smtpConnectionCheck({ mode: ctx.mode, integration: use, clock: ctx.clock, ...(deps.email ? { seams: deps.email } : {}) });
    if (!check.ok) return problemOutcome(check, integration.status);
    const result = await check.value();
    if (result.ok) return { status: 'CONNECTED' };
    switch (result.kind) {
      case 'auth':
        return { status: 'ERROR', errorCode: 'PROVIDER_AUTH', errorMessage: `The mail server rejected the username or password. ${result.message}` };
      case 'tls':
        return { status: 'ERROR', errorCode: 'SMTP_TLS_FAILED', errorMessage: `TLS could not be set up with the mail server (TLS is required). ${result.message}` };
      case 'blocked':
        return { status: 'ERROR', errorCode: 'CONFIG_INVALID', errorMessage: result.message };
      case 'rejected':
        return { status: 'ERROR', errorCode: 'PROVIDER_REJECTED', errorMessage: result.message };
      case 'transient':
        return { status: inconclusive(integration.status), errorCode: 'PROVIDER_UNAVAILABLE', errorMessage: result.message };
      case 'unreachable':
        return { status: inconclusive(integration.status), errorCode: 'PROVIDER_UNREACHABLE', errorMessage: result.message };
    }
  };
}
