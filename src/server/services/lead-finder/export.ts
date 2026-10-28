/**
 * "Download Excel" of a finder run (ADR-118 (c), slice F1). Needs `leads.export`; only the person
 * who started the run can download it (anyone else: 404, like the lead export); every download is
 * audited `finder.export` with its row count and column set, never content.
 *
 * - LIVE (Google content) exports only what may leave the product: the place ID, a Google Maps
 *   link built from it, the keyword and location, the workspace's own columns (imported, lead ID,
 *   stage) and the emails found on the business's own website with their source pages. Names,
 *   phones, addresses, websites, ratings and review counts never go into the file.
 * - DEMO (simulated listings) exports every simulated column, marked Simulated, and no Maps link
 *   (a simulated place ID has no map).
 * The file is written by `writeXlsx` (no formulas, every value text or a number).
 */
import type { LeadFinderResult } from '@/generated/prisma/client';
import { NotFoundError } from '@/lib/errors';
import { writeXlsx, type CellValue } from '@/lib/spreadsheet';
import type { SalesStage } from '@/lib/domain/enums';
import { placesMapsLink } from '@/server/adapters/places/port';
import type { AppCtx } from '@/server/auth/context';
import { requireActor, requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import { recordAudit } from '@/server/services/audit/record';
import { SALES_STAGE_CSV_LABELS } from '@/server/services/leads/csv';
import { finderEmails, hasDetails, loadFinderRun } from './runs';

export const FINDER_XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** Rows per file: every result of the largest run (10 x 10 cells of 60). */
export const FINDER_EXPORT_ROW_CAP = 6_000;

export const FINDER_EXPORT_LIVE_HEADER = ['Place ID', 'Google Maps link', 'Keyword', 'Location', 'Imported', 'Lead ID', 'Stage', 'Website emails', 'Email source pages'] as const;
export const FINDER_EXPORT_DEMO_HEADER = [
  'Simulated',
  'Name',
  'Category',
  'Phone',
  'Website',
  'Website listed',
  'Rating',
  'Reviews',
  'Address',
  'City',
  'State',
  'PIN code',
  'Keyword',
  'Location',
  'Place ID',
  'Imported',
  'Lead ID',
  'Stage',
  'Website emails',
  'Email source pages',
] as const;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `finder-<workspace slug>-<yyyymmdd>-<hhmm>.xlsx` in the workspace's time zone. */
export function finderExportFileName(slug: string, at: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return `finder-${slug.replace(/[^a-z0-9-]/g, '-')}-${parts.year}${parts.month}${parts.day}-${pad(Number(parts.hour) % 24)}${parts.minute}.xlsx`;
}

function emailCells(row: LeadFinderResult): [string, string] {
  const emails = finderEmails(row.emails);
  return [emails.map((e) => e.address).join(', '), [...new Set(emails.map((e) => e.sourceUrl))].join(', ')];
}

export async function buildFinderExport(ctx: AppCtx, runId: string): Promise<{ bytes: Uint8Array; fileName: string; rowCount: number; limited: boolean }> {
  requireCapability(ctx, 'leads.export');
  const workspaceId = requireWorkspace(ctx);
  const actor = requireActor(ctx);
  const run = await loadFinderRun(ctx, runId);
  if (run.requestedBy !== actor.userId) throw new NotFoundError();
  const now = ctx.clock.now();

  const rows = await ctx.db.leadFinderResult.findMany({ where: { runId: run.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: FINDER_EXPORT_ROW_CAP });
  const leadIds = [...new Set(rows.map((r) => r.importedLeadId).filter((id): id is string => id !== null))];
  const leads = leadIds.length === 0 ? [] : await ctx.db.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, salesStage: true } });
  const stageOf = new Map(leads.map((l) => [l.id, l.salesStage as SalesStage]));
  const stage = (row: LeadFinderResult) => (row.importedLeadId && stageOf.has(row.importedLeadId) ? SALES_STAGE_CSV_LABELS[stageOf.get(row.importedLeadId)!] : '');
  const imported = (row: LeadFinderResult) => (row.importedLeadId ? 'Yes' : 'No');

  const limited = !run.simulated;
  let header: readonly string[];
  let body: CellValue[][];
  if (limited) {
    header = FINDER_EXPORT_LIVE_HEADER;
    body = rows.map((r) => [r.placeId, placesMapsLink(r.placeId, `${r.keyword} ${r.location}`), r.keyword, r.location, imported(r), r.importedLeadId, stage(r), ...emailCells(r)]);
  } else {
    header = FINDER_EXPORT_DEMO_HEADER;
    body = rows.map((r) => {
      const shown = hasDetails(r, now);
      return [
        'Yes',
        shown ? r.name : null,
        shown ? r.category : null,
        shown ? r.phoneRaw : null,
        shown ? r.website : null,
        r.websiteListed ? 'Yes' : 'No',
        shown && r.ratingX10 !== null ? r.ratingX10 / 10 : null,
        shown ? r.reviewCount : null,
        shown ? r.address : null,
        shown ? r.city : null,
        shown ? r.state : null,
        shown ? r.pincode : null,
        r.keyword,
        r.location,
        r.placeId,
        imported(r),
        r.importedLeadId,
        stage(r),
        ...emailCells(r),
      ];
    });
  }
  const bytes = writeXlsx({ sheetName: 'Lead finder', header, rows: body });
  const workspace = await ctx.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { slug: true, timezone: true } });

  await withTx(ctx.db, async (tx) => {
    await recordAudit(tx, ctx, {
      action: 'finder.export',
      targetType: 'LeadFinderRun',
      targetId: run.id,
      workspaceId,
      simulated: run.simulated,
      summary: { rows: rows.length, columns: limited ? 'LIMITED' : 'FULL_SIMULATED', bytes: bytes.length },
    });
  });
  return { bytes, fileName: finderExportFileName(workspace.slug, now, workspace.timezone), rowCount: rows.length, limited };
}
