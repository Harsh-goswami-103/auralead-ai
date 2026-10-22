/**
 * The places provider of one workspace (ADR-118, slice F1), for the finder services and jobs: it
 * reads the workspace's stored mode and, in LIVE only, its GOOGLE_PLACES integration with the key
 * decrypted (outside any transaction), then asks the adapter registry. DEMO never loads or
 * decrypts anything and gets the simulated directory; LIVE gets the Places client or a typed
 * problem, never the simulated directory.
 */
import { CHECKABLE_STATUSES, placesCheckClient, resolvePlacesProvider, type PlacesSeams, type Resolution } from '@/server/adapters/registry';
import type { GooglePlacesClient } from '@/server/adapters/places/google-places';
import type { PlacesProvider } from '@/server/adapters/places/port';
import type { AppCtx } from '@/server/auth/context';
import { requireWorkspace } from '@/server/auth/guards';
import type { KeyRing } from '@/server/security/secrets';
import { loadIntegrationForUse } from '@/server/services/integrations/credentials';

export type PlacesDeps = { keyRing: KeyRing | null; seams?: PlacesSeams };

async function workspaceMode(ctx: AppCtx): Promise<'DEMO' | 'LIVE'> {
  const ws = await ctx.db.workspace.findUnique({ where: { id: requireWorkspace(ctx) }, select: { mode: true } });
  if (ws) return ws.mode;
  return ctx.mode === 'demo' ? 'LIVE' : 'DEMO';
}

export async function resolveWorkspacePlaces(ctx: AppCtx, deps: PlacesDeps): Promise<Resolution<PlacesProvider>> {
  const mode = await workspaceMode(ctx);
  const integration = ctx.mode === 'live' ? await loadIntegrationForUse(ctx.db, 'GOOGLE_PLACES', deps.keyRing) : null;
  return resolvePlacesProvider({ mode: ctx.mode, workspaceMode: mode, integration, clock: ctx.clock, ...(deps.seams ? { seams: deps.seams } : {}) });
}

/** The connection-test client (LIVE only). */
export async function resolvePlacesCheckClient(ctx: AppCtx, deps: PlacesDeps): Promise<Resolution<GooglePlacesClient>> {
  const integration = ctx.mode === 'live' ? await loadIntegrationForUse(ctx.db, 'GOOGLE_PLACES', deps.keyRing) : null;
  return placesCheckClient({ mode: ctx.mode, integration, clock: ctx.clock, ...(deps.seams ? { seams: deps.seams } : {}) });
}

/** Whether a LIVE workspace could search now, without decrypting anything (for the page's configuration gate). */
export async function placesConfigured(ctx: AppCtx): Promise<{ configured: boolean; status: string | null }> {
  if (ctx.mode === 'demo') return { configured: true, status: 'SIMULATED' };
  const row = await ctx.db.integration.findFirst({ where: { kind: 'GOOGLE_PLACES' }, select: { status: true, secrets: true } });
  if (!row) return { configured: false, status: null };
  const secrets = typeof row.secrets === 'object' && row.secrets !== null && !Array.isArray(row.secrets) ? (row.secrets as Record<string, unknown>) : {};
  const usable = CHECKABLE_STATUSES.has(row.status);
  return { configured: usable && typeof secrets.apiKey === 'string' && secrets.apiKey !== '', status: row.status };
}
