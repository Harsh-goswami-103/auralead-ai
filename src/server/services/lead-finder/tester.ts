/**
 * The Google Places connection test (ADR-118, slice F1; the live tester of the Integration center).
 * It decrypts the workspace's key, builds the client through the adapter registry and makes one
 * Text Search asking for place IDs only (page size 1). A connection test is itself a paid call, so
 * it runs only when a person clicks "Test connection" (never on the hourly schedule).
 *
 * Outcomes: an answer is CONNECTED; a rejected key ERROR PROVIDER_AUTH; a refused API (not
 * enabled, billing off, key restricted) ERROR PERMISSION_MISSING; an unreadable key ERROR
 * CREDENTIAL_UNREADABLE; throttling, 5xx or no answer say nothing about the key (DEGRADED when it
 * was CONNECTED, else it stays unverified). The key never reaches a stored message.
 */
import type { IntegrationStatus } from '@/lib/domain/enums';
import type { PlacesSeams } from '@/server/adapters/registry';
import type { KeyRing } from '@/server/security/secrets';
import { CREDENTIAL_UNREADABLE_CODE, CREDENTIAL_UNREADABLE_MESSAGE, type LiveConnectionTester, type LiveTestOutcome, type LiveTestStatus } from '@/server/services/integrations/types';
import { resolvePlacesCheckClient } from './provider';

function inconclusive(previous: IntegrationStatus): LiveTestStatus {
  return previous === 'CONNECTED' || previous === 'DEGRADED' ? 'DEGRADED' : 'CONFIGURED_UNVERIFIED';
}

export function placesTester(deps: { keyRing: KeyRing | null; places?: PlacesSeams }): LiveConnectionTester {
  return async (ctx, integration): Promise<LiveTestOutcome> => {
    const client = await resolvePlacesCheckClient(ctx, { keyRing: deps.keyRing, ...(deps.places ? { seams: deps.places } : {}) });
    if (!client.ok) {
      if (client.code === 'CREDENTIAL_UNREADABLE') return { status: 'ERROR', errorCode: CREDENTIAL_UNREADABLE_CODE, errorMessage: CREDENTIAL_UNREADABLE_MESSAGE };
      return { status: integration.status === 'ERROR' ? 'ERROR' : 'CONFIGURED_UNVERIFIED', errorCode: 'INTEGRATION_NOT_CONFIGURED', errorMessage: client.reason };
    }
    const r = await client.value.checkConnection();
    if (r.ok) return { status: 'CONNECTED' };
    switch (r.kind) {
      case 'auth':
        return { status: 'ERROR', errorCode: 'PROVIDER_AUTH', errorMessage: `Google rejected the API key; enter a valid key. ${r.message}` };
      case 'permission':
        return { status: 'ERROR', errorCode: 'PERMISSION_MISSING', errorMessage: `Google refused this key for the Places API (New): enable the API and billing for its project, or allow the API in the key's restrictions. ${r.message}` };
      case 'rate-limited':
        return { status: inconclusive(integration.status), errorCode: 'PROVIDER_RATE_LIMITED', errorMessage: r.message };
      case 'unavailable':
        return { status: inconclusive(integration.status), errorCode: 'PROVIDER_UNAVAILABLE', errorMessage: r.message };
      case 'unreachable':
        return { status: inconclusive(integration.status), errorCode: 'PROVIDER_UNREACHABLE', errorMessage: r.message };
      default:
        return { status: 'ERROR', errorCode: 'PROVIDER_REJECTED', errorMessage: r.message };
    }
  };
}
