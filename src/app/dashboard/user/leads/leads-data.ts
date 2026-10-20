/**
 * Server-side data of the Leads area (T26), shared by the client panel's Leads page and the
 * operator console: who may do what, the list page or the board, and the viewer's exports, read
 * through the services with the page's context and shaped for `LeadsWorkspace`. A page link whose
 * cursor no longer decodes shows the first page with a note instead of failing.
 */
import type { Gate } from '@/components/patterns/GatedAction';
import type { LeadsWorkspaceProps } from '@/components/leads/LeadsWorkspace';
import { AppError } from '@/lib/errors';
import type { LeadPageParams } from '@/lib/schemas/leads';
import type { AppCtx } from '@/server/auth/context';
import { listLeadExports } from '@/server/services/leads/export';
import { leadRowDto, listLeads, loadLeadBoard, loadLeadsAccess, type LeadRow, type LeadsAccess } from '@/server/services/leads/list';

export type LeadsAreaData = { access: LeadsAccess; workspace: Omit<LeadsWorkspaceProps, 'emptyWorkspace'> | null };

export async function loadLeadsArea(
  ctx: AppCtx,
  params: LeadPageParams,
  opts: { basePath: string; rowHref: (row: LeadRow) => string; workspaceSlug?: string; gates: { move: string; export: string } },
): Promise<LeadsAreaData> {
  const access = await loadLeadsAccess(ctx);
  if (!access.canRead) return { access, workspace: null };

  let cursorReset = false;
  let effective = params;
  const read = async (p: LeadPageParams) => {
    if (p.view === 'board') {
      const board = await loadLeadBoard(ctx, p);
      return { board: { total: board.total, columns: board.columns.map((c) => ({ stage: c.stage, total: c.total, rows: c.rows.map((r) => leadRowDto(r, opts.rowHref(r))) })) }, list: null };
    }
    const list = await listLeads(ctx, p);
    return { list: { total: list.total, nextCursor: list.nextCursor, prevCursor: list.prevCursor, rows: list.rows.map((r) => leadRowDto(r, opts.rowHref(r))) }, board: null };
  };
  let data: Awaited<ReturnType<typeof read>>;
  try {
    data = await read(params);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'CURSOR_INVALID') throw error;
    cursorReset = true;
    effective = { ...params, cursor: undefined, dir: 'next' };
    data = await read(effective);
  }
  const exports = access.canExport ? await listLeadExports(ctx) : [];
  const gate = (reason: string): Gate => ({ category: 'permission', reason });

  return {
    access,
    workspace: {
      basePath: opts.basePath,
      params: effective,
      timeZone: access.workspace.timezone,
      workspaceSlug: opts.workspaceSlug,
      moveGate: access.canMoveStage ? null : gate(opts.gates.move),
      exportGate: access.canExport ? null : gate(opts.gates.export),
      list: data.list,
      board: data.board,
      exports,
      cursorReset,
    },
  };
}
