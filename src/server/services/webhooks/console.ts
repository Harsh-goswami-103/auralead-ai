/**
 * Read model for the employee lead console (T11 part: source simulations and their results).
 * Everything is read through the tenant-scoped context: the workspace's most recent lead-source
 * events (status and per-record counts from the stored result, never payloads) and its most
 * recent leads. `canSimulate` is the server's answer to "may this caller run a simulation here",
 * using the same rules as POST /api/demo/simulate/[source]; the UI only renders it.
 */
import type { LeadSource, SalesStage, WebhookProvider, WebhookStatus } from '@/generated/prisma/client';
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireWorkspace } from '@/server/auth/guards';
import type { WebhookEventResult } from './events';

export type ConsoleEvent = {
  id: string;
  provider: WebhookProvider;
  status: WebhookStatus;
  simulated: boolean;
  receivedAt: Date;
  processedAt: Date | null;
  counts: { received: number; accepted: number; duplicate: number; review: number; rejected: number } | null;
  failureCode: string | null;
};

export type ConsoleLead = {
  id: string;
  displayName: string;
  firstSource: LeadSource;
  salesStage: SalesStage;
  city: string | null;
  simulated: boolean;
  createdAt: Date;
  /** T17: the lead's current score (null until the SCORE stage ran). */
  score: number | null;
};

export type SimulationGate = { allowed: true } | { allowed: false; category: 'mode' | 'permission'; reason: string };

export type LeadConsole = {
  workspace: { id: string; slug: string; name: string; timezone: string; mode: 'DEMO' | 'LIVE' };
  canReadLeads: boolean;
  simulation: SimulationGate;
  events: ConsoleEvent[];
  leads: ConsoleLead[];
};

const EVENT_LIMIT = 10;
const LEAD_LIMIT = 25;
const LEAD_SOURCES: readonly WebhookProvider[] = ['GOOGLE_SHEETS', 'META_ADS', 'GMAPS_EXTENSION'];

function simulationGate(ctx: AppCtx, workspaceMode: 'DEMO' | 'LIVE'): SimulationGate {
  if (ctx.mode !== 'demo' || workspaceMode !== 'DEMO') return { allowed: false, category: 'mode', reason: 'Source simulations run only in DEMO mode. In LIVE, leads arrive from the connected Sheets, Meta and extension integrations.' };
  if (!hasCapability(ctx, 'leads.write')) return { allowed: false, category: 'permission', reason: 'Your assignment does not include leads.write, which simulations need. Ask a super admin to grant it.' };
  return { allowed: true };
}

export async function loadLeadConsole(ctx: AppCtx): Promise<LeadConsole> {
  const workspaceId = requireWorkspace(ctx);
  const workspace = await ctx.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { id: true, slug: true, name: true, timezone: true, mode: true } });
  const canReadLeads = hasCapability(ctx, 'leads.read');
  const simulation = simulationGate(ctx, workspace.mode);
  if (!canReadLeads) return { workspace, canReadLeads, simulation, events: [], leads: [] };

  const [events, leads] = await Promise.all([
    ctx.db.webhookEvent.findMany({
      where: { workspaceId, provider: { in: [...LEAD_SOURCES] } },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: EVENT_LIMIT,
      select: { id: true, provider: true, status: true, simulated: true, receivedAt: true, processedAt: true, result: true },
    }),
    ctx.db.lead.findMany({
      where: { workspaceId, mergedIntoLeadId: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LEAD_LIMIT,
      select: { id: true, displayName: true, firstSource: true, salesStage: true, city: true, simulated: true, createdAt: true, score: true },
    }),
  ]);

  return {
    workspace,
    canReadLeads,
    simulation,
    events: events.map((e) => {
      const result = (e.result as WebhookEventResult | null) ?? null;
      return {
        id: e.id,
        provider: e.provider,
        status: e.status,
        simulated: e.simulated,
        receivedAt: e.receivedAt,
        processedAt: e.processedAt,
        counts: result?.kind === 'ingest' ? result.counts : null,
        failureCode: result?.kind === 'failed' ? result.code : null,
      };
    }),
    leads,
  };
}
