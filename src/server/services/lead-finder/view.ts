/**
 * The Lead Finder page's read model (ADR-118, slice F1): the workspace, the mode, what the viewer
 * may do (`finder.run`, `leads.write`, `leads.export`), whether a LIVE workspace has a usable Google
 * Places key (the configuration gate), the recent runs, and the selected run's filtered results.
 * Needs `leads.read`.
 */
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireCapability, requireWorkspace } from '@/server/auth/guards';
import { placesConfigured } from './provider';
import { getFinderRunView, listFinderRuns, type FinderRunDto, type FinderRunView } from './runs';
import type { FinderResultFilters } from './schemas';

export type FinderPageModel = {
  workspace: { name: string; slug: string; timezone: string };
  mode: 'demo' | 'live';
  can: { run: boolean; import: boolean; export: boolean };
  places: { configured: boolean; status: string | null };
  runs: FinderRunDto[];
  view: FinderRunView | null;
};

export async function getFinderPage(ctx: AppCtx, input: { runId?: string | null; filters: FinderResultFilters; page: number }): Promise<FinderPageModel> {
  requireCapability(ctx, 'leads.read');
  const workspaceId = requireWorkspace(ctx);
  const workspace = await ctx.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true, slug: true, timezone: true } });
  const runs = await listFinderRuns(ctx);
  const selected = input.runId ? (runs.find((r) => r.id === input.runId)?.id ?? (await ctx.db.leadFinderRun.findFirst({ where: { id: input.runId }, select: { id: true } }))?.id ?? null) : (runs[0]?.id ?? null);
  return {
    workspace,
    mode: ctx.mode,
    can: { run: hasCapability(ctx, 'finder.run'), import: hasCapability(ctx, 'leads.write'), export: hasCapability(ctx, 'leads.export') },
    places: await placesConfigured(ctx),
    runs,
    view: selected ? await getFinderRunView(ctx, selected, input.filters, input.page) : null,
  };
}
