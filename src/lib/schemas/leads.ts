/**
 * Leads area schemas (T26, plan §11 M4, R31), shared by the list and board pages of both panels,
 * the stage, export and scoring routes, and the services (plan §2: one schema set).
 *
 * The list query lives in the URL (`?q=&stage=&source=&score=&handedOver=1&sort=&cursor=&dir=&view=&lead=`), so
 * a reload, a shared link and the back button all show the same rows. Parsing the URL is lenient:
 * a hand-edited or stale value is dropped instead of failing the page. Request bodies are strict.
 */
import { z } from 'zod';
import { LeadSource, SalesStage } from '../domain/enums';
import { workspaceSlugField } from './lead-console';

/** Rows per table page (the e2e 50/51 boundary). */
export const LEAD_PAGE_SIZE = 50;
/** Counts stop here and read "1,000+": counting every row of a large workspace is not free. */
export const LEAD_COUNT_CAP = 1000;
/** Cards per Kanban column (newest first in the chosen sort); the column count says how many match. */
export const LEAD_BOARD_COLUMN_LIMIT = 30;
export const LEAD_SEARCH_MAX = 100;

export const LEAD_SORTS = ['newest', 'oldest', 'score', 'name'] as const;
export type LeadSort = (typeof LEAD_SORTS)[number];
export const LEAD_SORT_LABELS: Readonly<Record<LeadSort, string>> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  score: 'Highest score',
  name: 'Name A to Z',
};

/** Score bands of the filter: high 70-100, medium 40-69, low 0-39, or not scored yet. */
export const SCORE_BANDS = ['high', 'medium', 'low', 'unscored'] as const;
export type ScoreBand = (typeof SCORE_BANDS)[number];
export const SCORE_BAND_LABELS: Readonly<Record<ScoreBand, string>> = {
  high: 'Score 70 to 100',
  medium: 'Score 40 to 69',
  low: 'Score 0 to 39',
  unscored: 'Not scored',
};
export const SCORE_BAND_RANGES: Readonly<Record<Exclude<ScoreBand, 'unscored'>, { min: number; max: number }>> = {
  high: { min: 70, max: 100 },
  medium: { min: 40, max: 69 },
  low: { min: 0, max: 39 },
};

export const LEAD_VIEWS = ['table', 'board'] as const;
export type LeadView = (typeof LEAD_VIEWS)[number];

const cursorField = z.string().regex(/^[A-Za-z0-9_-]{1,600}$/);
const id = z.string().min(1).max(64);

/** The filters a list, a board and an export share (no paging). */
export const LeadFilters = z.object({
  q: z.string().trim().max(LEAD_SEARCH_MAX).optional(),
  stage: z.enum(SalesStage).optional(),
  source: z.enum(LeadSource).optional(),
  score: z.enum(SCORE_BANDS).optional(),
  /** ADR-124: only leads handed over to the client (`Lead.handedOverAt` set). */
  handedOver: z.boolean().optional(),
  sort: z.enum(LEAD_SORTS).default('newest'),
});

/** The URL value of the handed-over filter (`?handedOver=1`). */
export const HANDED_OVER_PARAM = '1';
export type LeadFilters = z.output<typeof LeadFilters>;

export type LeadListParams = LeadFilters & { cursor?: string; dir: 'next' | 'prev' };
export type LeadPageParams = LeadListParams & { view: LeadView; lead?: string };

type SearchParamsInput = Record<string, string | string[] | undefined> | URLSearchParams;

function first(params: SearchParamsInput, key: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

function pick<T>(schema: z.ZodType<T>, value: string | undefined): T | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Reads the page's search params leniently: unknown or invalid values are ignored. */
export function parseLeadPageParams(params: SearchParamsInput): LeadPageParams {
  const q = first(params, 'q')?.trim().slice(0, LEAD_SEARCH_MAX);
  return {
    q: q ? q : undefined,
    stage: pick(z.enum(SalesStage), first(params, 'stage')),
    source: pick(z.enum(LeadSource), first(params, 'source')),
    score: pick(z.enum(SCORE_BANDS), first(params, 'score')),
    handedOver: first(params, 'handedOver') === HANDED_OVER_PARAM ? true : undefined,
    sort: pick(z.enum(LEAD_SORTS), first(params, 'sort')) ?? 'newest',
    cursor: pick(cursorField, first(params, 'cursor')),
    dir: first(params, 'dir') === 'prev' ? 'prev' : 'next',
    view: first(params, 'view') === 'board' ? 'board' : 'table',
    lead: pick(id, first(params, 'lead')),
  };
}

/**
 * The query string for a leads page: the current params with `overrides` applied (undefined
 * removes a key). Defaults are left out so URLs stay short; a filter change drops the cursor.
 */
export function leadPageSearch(current: Partial<LeadPageParams>, overrides: Partial<Record<keyof LeadPageParams, string | undefined>> = {}): string {
  const merged: Record<string, string | undefined> = {
    q: current.q,
    stage: current.stage,
    source: current.source,
    score: current.score,
    handedOver: current.handedOver ? HANDED_OVER_PARAM : undefined,
    sort: current.sort,
    view: current.view,
    cursor: current.cursor,
    dir: current.dir,
    lead: current.lead,
  };
  for (const [k, v] of Object.entries(overrides)) merged[k] = v;
  const out = new URLSearchParams();
  for (const key of ['view', 'q', 'stage', 'source', 'score', 'handedOver', 'sort', 'cursor', 'dir', 'lead'] as const) {
    const v = merged[key];
    if (v === undefined || v === '') continue;
    if (key === 'sort' && v === 'newest') continue;
    if (key === 'view' && v === 'table') continue;
    if (key === 'dir' && (v === 'next' || merged.cursor === undefined)) continue;
    out.set(key, v);
  }
  const s = out.toString();
  return s ? `?${s}` : '';
}

/** True when any filter narrows the list (used for the empty state wording). */
export function hasLeadFilters(p: Partial<LeadFilters>): boolean {
  return Boolean(p.q || p.stage || p.source || p.score || p.handedOver);
}

// ---- Stage moves (stage CAS) --------------------------------------------------------------------

export const LEAD_LOST_REASON_MIN = 3;

export const LeadStageBody = z.object({
  workspaceSlug: workspaceSlugField.optional(),
  toStage: z.enum(SalesStage),
  /** The lead's stageVersion the person saw; a newer one answers 409. */
  expectedStageVersion: z.number().int().min(0),
  /** Why the lead is lost (required for LOST, kept on the audit row for every manual move). */
  reason: z.string().trim().max(500).optional(),
});
export type LeadStageBody = z.output<typeof LeadStageBody>;

export type LeadStageResult = { lead: { id: string; salesStage: SalesStage; stageVersion: number }; changed: boolean };

// ---- CSV export ---------------------------------------------------------------------------------

/** A client-generated key per export click: a double click or retry returns the same export. */
export const LeadExportRequestKey = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'requestKey must be 8-64 letters, digits, _ or -');

export const LeadExportBody = z.object({
  workspaceSlug: workspaceSlugField.optional(),
  requestKey: LeadExportRequestKey,
  filters: LeadFilters.default({ sort: 'newest' }),
});
export type LeadExportBody = z.output<typeof LeadExportBody>;

export const LeadWorkspaceQuery = z.object({ workspaceSlug: workspaceSlugField.optional() });
export type LeadWorkspaceQuery = z.output<typeof LeadWorkspaceQuery>;

/** Hours an export file can be downloaded after it was written. */
export const LEAD_EXPORT_TTL_HOURS = 24;
/** Rows per export file; more matches are cut here and the export says so. */
export const LEAD_EXPORT_ROW_CAP = 50_000;

export type LeadExportStatus = 'QUEUED' | 'READY' | 'FAILED' | 'EXPIRED';

export type LeadExportDto = {
  id: string;
  status: LeadExportStatus;
  /** READY whose expiry passed reads EXPIRED even before the purge job ran. */
  effectiveStatus: LeadExportStatus;
  filters: LeadFilters;
  rowCount: number | null;
  truncated: boolean;
  bytes: number | null;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  downloadCount: number;
};

export function leadExportDownloadHref(exportId: string, workspaceSlug?: string): string {
  const q = workspaceSlug ? `?${new URLSearchParams({ workspaceSlug }).toString()}` : '';
  return `/api/app/leads/exports/${encodeURIComponent(exportId)}/download${q}`;
}

// ---- Scoring configuration tab (P9) --------------------------------------------------------------

/** Leads in the preview sample (P9: "a preview of score changes on 20 sample leads"). */
export const SCORING_PREVIEW_SAMPLE = 20;

export const ScoringPreviewBody = z.object({
  workspaceSlug: workspaceSlugField.optional(),
  /** Validated by the scoring schema in the service, so a bad config answers with its issues. */
  config: z.unknown(),
});
export type ScoringPreviewBody = z.output<typeof ScoringPreviewBody>;

export const ScoringActivateBody = z.object({
  workspaceSlug: workspaceSlugField.optional(),
  /** The active version number the editor saw (0 when none); a mismatch answers 409. */
  expectedActiveVersion: z.number().int().min(0),
  config: z.unknown(),
});
export type ScoringActivateBody = z.output<typeof ScoringActivateBody>;

export type ScoringPreviewRow = {
  leadId: string;
  displayName: string;
  /** The score stored on the lead now (null when not scored). */
  currentScore: number | null;
  proposedScore: number;
  delta: number | null;
  unknownInputs: number;
};

export type ScoringPreviewDto = {
  sampleSize: number;
  rows: ScoringPreviewRow[];
  /** Scored sample leads whose score would change (an unscored lead has no change to count). */
  changed: number;
  /** Sample leads without a current score; left out of `changed` and of both averages (ADR-73). */
  unscored: number;
  /** Both averages are over the scored sample leads only, so they compare the same rows. */
  averageCurrent: number | null;
  averageProposed: number | null;
};

export type ScoringActivateDto = { versionId: string; version: number; previousVersion: number | null; rescoreJobId: string };

// ---- List and board rows -------------------------------------------------------------------------

export type CappedCountDto = { count: number; capped: boolean };

export type LeadRowDto = {
  id: string;
  displayName: string;
  city: string | null;
  category: string | null;
  phoneE164: string | null;
  emailNormalized: string | null;
  firstSource: (typeof LeadSource)[number];
  salesStage: (typeof SalesStage)[number];
  stageVersion: number;
  score: number | null;
  simulated: boolean;
  createdAt: string;
  /** Where the lead's name links: the detail sheet (client panel) or the lead page (operator console). */
  href: string;
};

export type BoardColumnDto = { stage: (typeof SalesStage)[number]; rows: LeadRowDto[]; total: CappedCountDto };

// ---- Lead detail (sheet and page) ----------------------------------------------------------------

export type ConsentState = 'OPTED_OUT' | 'OPT_IN' | 'B2B_ATTESTED' | 'CUSTOMER_MESSAGED' | 'NONE' | 'NO_CONTACT';

export type ConsentChannelDto = {
  channel: 'WHATSAPP' | 'EMAIL';
  state: ConsentState;
  /** Evidence time of the consent, or when the opt-out was recorded (ISO). */
  since: string | null;
  /** The consent source or the suppression reason. */
  source: string | null;
};

export type SourceRecordDto = {
  id: string;
  source: string;
  status: string;
  reasonCode: string | null;
  externalId: string;
  receivedAt: string;
  extractedAt: string | null;
  mappingVersion: number | null;
  attribution: Array<{ key: string; value: string }>;
  batch: { externalBatchId: string; simulated: boolean } | null;
};

export type LeadProfileDto = {
  workspace: { id: string; slug: string; name: string; timezone: string };
  lead: {
    id: string;
    displayName: string;
    category: string | null;
    phoneE164: string | null;
    emailNormalized: string | null;
    website: string | null;
    websiteStatus: string;
    address: string | null;
    city: string | null;
    ratingX10: number | null;
    reviewCount: number | null;
    salesStage: (typeof SalesStage)[number];
    stageVersion: number;
    firstSource: (typeof LeadSource)[number];
    simulated: boolean;
    score: number | null;
    createdAt: string;
    merged: boolean;
  };
  score: {
    configVersion: number | null;
    reasons: Array<{ input: string; label: string; points: number; maxPoints: number }>;
    unknownInputs: Array<{ input: string; label: string; reasonCode: string }>;
  };
  consent: ConsentChannelDto[];
  sources: SourceRecordDto[];
  quotes: Array<{ id: string; number: string; status: string; currentVersionNo: number; totalPaise: string | null; validUntil: string | null }>;
  conversations: Array<{ id: string; channel: 'WHATSAPP' | 'EMAIL'; lastInboundProviderAt: string | null }>;
  permissions: { canMoveStage: boolean };
};
