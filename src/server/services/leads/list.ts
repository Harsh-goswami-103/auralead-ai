/**
 * The Leads list and board read models (T26, R31, plan §11 M4). Reads only, through the
 * tenant-scoped context (`leads.read`).
 *
 * - Search runs on the normalized columns (plan §5.8: no case-insensitive collation, no LIKE on
 *   display text): the name through the same `normalizeName` ingestion stores in
 *   `nameNormalized` (case, accents and punctuation folded; Devanagari folded the same way on
 *   both sides), phone digits against `phoneE164` (Devanagari digits read as digits), and a
 *   lowercase fragment against `emailNormalized`. A query with nothing searchable matches nothing.
 * - Pages are keyset pages over a total order (the sort key, then the id), forward with `cursor`
 *   and backward with `dir: 'prev'`, so a page never shifts or repeats rows when leads arrive.
 *   The score sort keeps unscored leads last in both directions.
 * - Counts are capped at LEAD_COUNT_CAP (`count({ take })`), so a big workspace never pays for an
 *   exact count it does not need; the page says "1,000+".
 * - Merged leads (they live on in the lead they were merged into) are never listed.
 */
import type { LeadSource, Prisma, SalesStage } from '@/generated/prisma/client';
import { ValidationError } from '@/lib/errors';
import {
  LEAD_BOARD_COLUMN_LIMIT,
  LEAD_COUNT_CAP,
  LEAD_PAGE_SIZE,
  SCORE_BAND_RANGES,
  type LeadFilters,
  type LeadListParams,
  type LeadRowDto,
  type LeadSort,
} from '@/lib/schemas/leads';
import { SalesStage as SALES_STAGES } from '@/lib/domain/enums';
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireCapability, requireWorkspace } from '@/server/auth/guards';
import { normalizeName } from './normalize';

export type LeadRow = {
  id: string;
  displayName: string;
  city: string | null;
  category: string | null;
  phoneE164: string | null;
  emailNormalized: string | null;
  firstSource: LeadSource;
  salesStage: SalesStage;
  stageVersion: number;
  score: number | null;
  simulated: boolean;
  createdAt: Date;
};

export type CappedCount = { count: number; capped: boolean };

export type LeadListResult = {
  rows: LeadRow[];
  total: CappedCount;
  nextCursor: string | null;
  prevCursor: string | null;
  pageSize: number;
};

export type LeadBoardColumn = { stage: SalesStage; rows: LeadRow[]; total: CappedCount };
export type LeadBoard = { columns: LeadBoardColumn[]; total: CappedCount };

const ROW_SELECT = {
  id: true,
  displayName: true,
  city: true,
  category: true,
  phoneE164: true,
  emailNormalized: true,
  firstSource: true,
  salesStage: true,
  stageVersion: true,
  score: true,
  simulated: true,
  createdAt: true,
  nameNormalized: true,
} as const satisfies Prisma.LeadSelect;

type SelectedRow = LeadRow & { nameNormalized: string };

// ---- Search -------------------------------------------------------------------------------------

const DEVANAGARI_ZERO = 0x0966;

/** Digits of a query, Devanagari digits (U+0966..U+096F) read as 0-9. */
export function searchDigits(q: string): string {
  let out = '';
  for (const ch of q.normalize('NFKC')) {
    const code = ch.codePointAt(0)!;
    if (ch >= '0' && ch <= '9') out += ch;
    else if (code >= DEVANAGARI_ZERO && code <= DEVANAGARI_ZERO + 9) out += String(code - DEVANAGARI_ZERO);
  }
  return out;
}

/** The search condition for `q`, or a condition that matches nothing when `q` has no usable term. */
export function leadSearchWhere(q: string): Prisma.LeadWhereInput {
  const or: Prisma.LeadWhereInput[] = [];
  const name = normalizeName(q);
  if (name.length > 0) or.push({ nameNormalized: { contains: name } });
  const digits = searchDigits(q);
  if (digits.length >= 3) or.push({ phoneE164: { contains: digits } });
  const email = q.normalize('NFKC').trim().toLowerCase();
  // Only the characters an address can hold, so LIKE wildcards (% and _) never reach the pattern.
  if (email.length >= 3 && /^[a-z0-9@.+-]+$/.test(email)) or.push({ emailNormalized: { contains: email } });
  return or.length > 0 ? { OR: or } : { id: { in: [] } };
}

export function leadFilterWhere(filters: Partial<LeadFilters>): Prisma.LeadWhereInput {
  const and: Prisma.LeadWhereInput[] = [{ mergedIntoLeadId: null }];
  if (filters.q) and.push(leadSearchWhere(filters.q));
  if (filters.stage) and.push({ salesStage: filters.stage });
  if (filters.source) and.push({ firstSource: filters.source });
  if (filters.score === 'unscored') and.push({ score: null });
  else if (filters.score) and.push({ score: { gte: SCORE_BAND_RANGES[filters.score].min, lte: SCORE_BAND_RANGES[filters.score].max } });
  return { AND: and };
}

// ---- Keyset order -------------------------------------------------------------------------------

type SortField = 'createdAt' | 'score' | 'nameNormalized';
type SortSpec = { field: SortField; dir: 'asc' | 'desc'; nullable: boolean };

const SORTS: Readonly<Record<LeadSort, SortSpec>> = {
  newest: { field: 'createdAt', dir: 'desc', nullable: false },
  oldest: { field: 'createdAt', dir: 'asc', nullable: false },
  score: { field: 'score', dir: 'desc', nullable: true },
  name: { field: 'nameNormalized', dir: 'asc', nullable: false },
};

type CursorValue = string | number | null;
type Cursor = { v: CursorValue; id: string };

function invalidCursor(): ValidationError {
  return new ValidationError({ code: 'CURSOR_INVALID', userMessage: 'This page link is no longer valid. Start from the first page.' });
}

export function encodeLeadCursor(spec: LeadSort, row: Pick<SelectedRow, 'id' | 'createdAt' | 'score' | 'nameNormalized'>): string {
  const field = SORTS[spec].field;
  const v: CursorValue = field === 'createdAt' ? row.createdAt.toISOString() : field === 'score' ? row.score : row.nameNormalized;
  return Buffer.from(JSON.stringify([v, row.id]), 'utf8').toString('base64url');
}

function decodeCursor(sort: LeadSort, raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[1] !== 'string' || parsed[1].length === 0 || parsed[1].length > 64) throw invalidCursor();
  const [v, id] = parsed as [unknown, string];
  const field = SORTS[sort].field;
  if (field === 'createdAt' && (typeof v !== 'string' || Number.isNaN(Date.parse(v)))) throw invalidCursor();
  if (field === 'score' && v !== null && (typeof v !== 'number' || !Number.isInteger(v))) throw invalidCursor();
  if (field === 'nameNormalized' && typeof v !== 'string') throw invalidCursor();
  return { v: v as CursorValue, id };
}

function fieldValue(field: SortField, v: CursorValue): string | number | Date {
  return field === 'createdAt' ? new Date(v as string) : (v as string | number);
}

/**
 * Rows strictly after the cursor in traversal order. `forward` walks the sort order; backward
 * walks it reversed. Nulls (score only) sit after every non-null value in the sort order.
 */
function keysetWhere(spec: SortSpec, c: Cursor, forward: boolean): Prisma.LeadWhereInput {
  const cmp = (spec.dir === 'desc') === forward ? 'lt' : 'gt';
  const f = spec.field;
  if (c.v === null) {
    // Only reachable for the nullable score: inside the null block, ordered by id.
    return forward ? { [f]: null, id: { [cmp]: c.id } } : { OR: [{ [f]: { not: null } }, { [f]: null, id: { [cmp]: c.id } }] };
  }
  const value = fieldValue(f, c.v);
  const or: Prisma.LeadWhereInput[] = [{ [f]: { [cmp]: value } }, { [f]: value, id: { [cmp]: c.id } }];
  if (spec.nullable && forward) or.push({ [f]: null });
  return { OR: or };
}

function orderBy(spec: SortSpec, forward: boolean): Prisma.LeadOrderByWithRelationInput[] {
  const dir = forward ? spec.dir : spec.dir === 'asc' ? 'desc' : 'asc';
  const key: Prisma.LeadOrderByWithRelationInput = spec.nullable ? { [spec.field]: { sort: dir, nulls: forward ? 'last' : 'first' } } : { [spec.field]: dir };
  return [key, { id: dir }];
}

/** The forward keyset order of a sort, for readers that walk every matching lead (the CSV export). */
export function leadSortOrder(sort: LeadSort): Prisma.LeadOrderByWithRelationInput[] {
  return orderBy(SORTS[sort], true);
}

/** Leads after `row` in the sort's order (the next batch of a full walk). */
export function leadsAfter(sort: LeadSort, row: Pick<SelectedRow, 'id' | 'createdAt' | 'score' | 'nameNormalized'>): Prisma.LeadWhereInput {
  const field = SORTS[sort].field;
  const v: CursorValue = field === 'createdAt' ? row.createdAt.toISOString() : field === 'score' ? row.score : row.nameNormalized;
  return keysetWhere(SORTS[sort], { v, id: row.id }, true);
}

function toRow(r: SelectedRow): LeadRow {
  return {
    id: r.id,
    displayName: r.displayName,
    city: r.city,
    category: r.category,
    phoneE164: r.phoneE164,
    emailNormalized: r.emailNormalized,
    firstSource: r.firstSource,
    salesStage: r.salesStage,
    stageVersion: r.stageVersion,
    score: r.score,
    simulated: r.simulated,
    createdAt: r.createdAt,
  };
}

async function cappedCount(ctx: AppCtx, where: Prisma.LeadWhereInput): Promise<CappedCount> {
  const n = await ctx.db.lead.count({ where, take: LEAD_COUNT_CAP + 1 });
  return n > LEAD_COUNT_CAP ? { count: LEAD_COUNT_CAP, capped: true } : { count: n, capped: false };
}

// ---- Reads --------------------------------------------------------------------------------------

export async function listLeads(ctx: AppCtx, params: LeadListParams, opts: { pageSize?: number } = {}): Promise<LeadListResult> {
  requireCapability(ctx, 'leads.read');
  const pageSize = opts.pageSize ?? LEAD_PAGE_SIZE;
  const spec = SORTS[params.sort];
  const base = leadFilterWhere(params);
  const cursor = params.cursor ? decodeCursor(params.sort, params.cursor) : null;
  const forward = cursor === null || params.dir !== 'prev';
  const where: Prisma.LeadWhereInput = cursor ? { AND: [base, keysetWhere(spec, cursor, forward)] } : base;

  const [found, total] = await Promise.all([
    ctx.db.lead.findMany({ where, orderBy: orderBy(spec, forward), take: pageSize + 1, select: ROW_SELECT }) as Promise<SelectedRow[]>,
    cappedCount(ctx, base),
  ]);
  const more = found.length > pageSize;
  const page = found.slice(0, pageSize);
  if (!forward) page.reverse();

  const firstRow = page[0];
  const lastRow = page[page.length - 1];
  let nextCursor: string | null;
  let prevCursor: string | null;
  if (forward) {
    nextCursor = more && lastRow ? encodeLeadCursor(params.sort, lastRow) : null;
    prevCursor = cursor !== null && firstRow ? encodeLeadCursor(params.sort, firstRow) : null;
  } else {
    prevCursor = more && firstRow ? encodeLeadCursor(params.sort, firstRow) : null;
    nextCursor = lastRow ? encodeLeadCursor(params.sort, lastRow) : null;
  }
  return { rows: page.map(toRow), total, nextCursor, prevCursor, pageSize };
}

/** A row as the client components take it: ISO dates and the link the page chose for its name. */
export function leadRowDto(row: LeadRow, href: string): LeadRowDto {
  return { ...row, createdAt: row.createdAt.toISOString(), href };
}

export type LeadsAccess = {
  workspace: { id: string; slug: string; name: string; timezone: string };
  canRead: boolean;
  canMoveStage: boolean;
  canExport: boolean;
  /** The workspace has no lead at all (the empty state says how leads arrive, not "no match"). */
  empty: boolean;
};

/** Who may do what on the Leads pages of the context's workspace (read checks happen in the reads). */
export async function loadLeadsAccess(ctx: AppCtx): Promise<LeadsAccess> {
  const workspaceId = requireWorkspace(ctx);
  const canRead = hasCapability(ctx, 'leads.read');
  const [workspace, any] = await Promise.all([
    ctx.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { id: true, slug: true, name: true, timezone: true } }),
    canRead ? ctx.db.lead.findFirst({ where: { mergedIntoLeadId: null }, select: { id: true } }) : Promise.resolve(null),
  ]);
  return { workspace, canRead, canMoveStage: hasCapability(ctx, 'leads.write'), canExport: hasCapability(ctx, 'leads.export'), empty: canRead && any === null };
}

/** The Kanban board: every stage's first cards in the chosen order, with a capped count each. */
export async function loadLeadBoard(ctx: AppCtx, filters: LeadFilters, opts: { columnLimit?: number } = {}): Promise<LeadBoard> {
  requireCapability(ctx, 'leads.read');
  const limit = opts.columnLimit ?? LEAD_BOARD_COLUMN_LIMIT;
  const spec = SORTS[filters.sort];
  // The board's columns are the stages, so a stage filter does not apply to it.
  const base = leadFilterWhere({ ...filters, stage: undefined });
  const columns = await Promise.all(
    SALES_STAGES.map(async (stage) => {
      const where: Prisma.LeadWhereInput = { AND: [base, { salesStage: stage }] };
      const [rows, total] = await Promise.all([
        ctx.db.lead.findMany({ where, orderBy: orderBy(spec, true), take: limit, select: ROW_SELECT }) as Promise<SelectedRow[]>,
        cappedCount(ctx, where),
      ]);
      return { stage, rows: rows.map(toRow), total };
    }),
  );
  return { columns, total: await cappedCount(ctx, base) };
}
