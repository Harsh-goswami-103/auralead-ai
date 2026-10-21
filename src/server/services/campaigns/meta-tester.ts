/**
 * The Meta Lead Ads connection tester (T35; ADR-80 seam 1, registered in `liveConnectionTesters`).
 * It never reports CONNECTED without real answers from Meta that match the configuration:
 *  1. GET /<page id>?fields=id,name with the saved token (META_GRAPH_VERSION): the id must come
 *     back as configured;
 *  2. when an ad account is configured, GET /act_<id>?fields=id,account_id,name,currency,... with
 *     the same token (META_MARKETING_VERSION): the account id must come back as configured and a
 *     currency must be present. A configured ad account on a server without
 *     META_MARKETING_VERSION cannot be verified, so the result is not CONNECTED.
 * Failure mapping as the other testers: a rejected token is ERROR PROVIDER_AUTH, a missing
 * permission ERROR PERMISSION_MISSING naming it, an unknown id ERROR CONFIG_INVALID, an
 * unreadable secret ERROR CREDENTIAL_UNREADABLE; throttling, 5xx and no answer are inconclusive
 * (DEGRADED after CONNECTED, otherwise CONFIGURED_UNVERIFIED).
 */
import type { IntegrationStatus } from '@/lib/domain/enums';
import { classifyMetaFailure, parseAdAccount } from '@/server/adapters/meta/graph';
import { CHECKABLE_STATUSES, metaLeadsClient, metaMarketingClient, type Problem } from '@/server/adapters/registry';
import type { GraphCall } from '@/server/adapters/whatsapp/cloud-api';
import { loadIntegrationForUse } from '@/server/services/integrations/credentials';
import type { LiveAdapterDeps } from '@/server/services/integrations/live-testers';
import { CREDENTIAL_UNREADABLE_CODE, CREDENTIAL_UNREADABLE_MESSAGE, type LiveConnectionTester, type LiveTestOutcome, type LiveTestStatus } from '@/server/services/integrations/types';

function inconclusive(previous: IntegrationStatus): LiveTestStatus {
  return previous === 'CONNECTED' || previous === 'DEGRADED' ? 'DEGRADED' : 'CONFIGURED_UNVERIFIED';
}

function problemOutcome(p: Problem, previous: IntegrationStatus): LiveTestOutcome {
  if (p.code === 'CREDENTIAL_UNREADABLE') return { status: 'ERROR', errorCode: CREDENTIAL_UNREADABLE_CODE, errorMessage: CREDENTIAL_UNREADABLE_MESSAGE };
  return { status: previous === 'ERROR' ? 'ERROR' : 'CONFIGURED_UNVERIFIED', errorCode: 'INTEGRATION_NOT_CONFIGURED', errorMessage: p.reason };
}

/** A failed Meta read as a test outcome. */
export function metaFailureOutcome(call: Extract<GraphCall<unknown>, { ok: false }>, required: string, previous: IntegrationStatus): LiveTestOutcome {
  const f = classifyMetaFailure(call, required);
  switch (f.code) {
    case 'PROVIDER_AUTH':
      return { status: 'ERROR', errorCode: 'PROVIDER_AUTH', errorMessage: f.message };
    case 'PERMISSION_MISSING':
      return { status: 'ERROR', errorCode: 'PERMISSION_MISSING', errorMessage: f.message };
    case 'NOT_FOUND':
      return { status: 'ERROR', errorCode: 'CONFIG_INVALID', errorMessage: `Meta did not accept the configured ID for this token; check the Page ID and ad account ID. ${f.message}` };
    case 'PROVIDER_RATE_LIMITED':
    case 'PROVIDER_UNAVAILABLE':
    case 'PROVIDER_UNREACHABLE':
      return { status: inconclusive(previous), errorCode: f.code, errorMessage: f.message };
    case 'PROVIDER_REJECTED':
      return { status: 'ERROR', errorCode: 'PROVIDER_REJECTED', errorMessage: f.message };
  }
}

function configString(config: Readonly<Record<string, unknown>>, key: string): string | null {
  const v = config[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

export function metaAdsTester(deps: LiveAdapterDeps): LiveConnectionTester {
  return async (ctx, integration) => {
    const use = await loadIntegrationForUse(ctx.db, 'META_ADS', deps.keyRing);
    if (!use) return { status: 'CONFIGURED_UNVERIFIED', errorCode: 'INTEGRATION_NOT_CONFIGURED', errorMessage: 'no Meta Lead Ads integration is stored' };
    const base = { mode: ctx.mode, integration: use, graphVersion: deps.graphVersion, marketingVersion: deps.marketingVersion ?? null, clock: ctx.clock, usable: CHECKABLE_STATUSES, ...(deps.graph ? { graph: deps.graph } : {}) };
    const leads = metaLeadsClient(base);
    if (!leads.ok) return problemOutcome(leads, integration.status);
    const pageId = configString(use.config, 'pageId');
    if (!pageId) return { status: 'CONFIGURED_UNVERIFIED', errorCode: 'INTEGRATION_NOT_CONFIGURED', errorMessage: 'the Page ID is not set' };
    const page = await leads.value.getPage(pageId);
    if (!page.ok) return metaFailureOutcome(page, 'pages_show_list', integration.status);
    if (String(page.data.id ?? '') !== pageId) return { status: 'ERROR', errorCode: 'CONFIG_INVALID', errorMessage: 'Meta answered for a different Page ID than the one configured.' };

    if (configString(use.config, 'adAccountId') !== null) {
      const marketing = metaMarketingClient(base);
      if (!marketing.ok) return problemOutcome(marketing, integration.status);
      const account = await marketing.value.getAdAccount();
      if (!account.ok) return metaFailureOutcome(account, 'ads_read', integration.status);
      const parsed = parseAdAccount(account.data);
      if (!parsed || parsed.accountId !== marketing.value.adAccountId) {
        return { status: 'ERROR', errorCode: 'CONFIG_INVALID', errorMessage: 'Meta answered for a different ad account, or without its currency.' };
      }
    }
    return { status: 'CONNECTED' };
  };
}
