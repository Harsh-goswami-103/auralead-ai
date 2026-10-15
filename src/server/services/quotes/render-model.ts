/**
 * The quote render model (T16, C1, ADR-08): one `buildQuoteRenderModel` feeds both presenters,
 * `QuoteDocument.tsx` (the HTML page) and `QuotePdf.tsx` (the react-pdf document), so the two can
 * never disagree on a number.
 *
 *  - Money comes from the persisted version and items (plan §5.4: totals are never recomputed at
 *    render), formatted once with `formatINR`.
 *  - The document facts (sender name, time zone, brand colour, terms, GSTIN, recipient name) are
 *    snapshotted on the version when it is created (`QuoteVersion.snapshot.document`), so a later
 *    branding or lead edit cannot make the stored PDF and the HTML page disagree. Versions written
 *    before the snapshot existed fall back to the current workspace and lead rows.
 *  - `contentHash` is sha256 over the canonical JSON of the commercial content (everything but the
 *    watermark and the hash itself). Its first 12 hex characters are printed in the PDF footer and
 *    on the page, so a reader can match a PDF to the page it came from.
 *  - The watermark "DEMO: not a valid offer" is set only in demo (plan §10).
 */
import { createHash } from 'node:crypto';
import type { DiscountKind, Prisma, PrismaClient } from '@/generated/prisma/client';
import { DEFAULT_TIMEZONE, formatDate } from '@/lib/format/date';
import { formatINR } from '@/lib/money';
import { NotFoundError } from '@/lib/errors';

export const DEMO_WATERMARK = 'DEMO: not a valid offer';
export const QUOTE_NOTICE = 'Quotation, not a tax invoice';
const DEFAULT_BRAND = '#111318';

export type DocumentSnapshot = {
  senderName: string;
  timeZone: string;
  brandColor: string;
  termsText: string | null;
  gstin: string | null;
  recipientName: string;
};

export type RenderSource = {
  quoteNumber: string;
  version: {
    versionNo: number;
    createdAt: Date;
    validUntil: Date;
    scopeText: string;
    timelineText: string;
    discountKind: DiscountKind;
    discountValue: bigint;
    taxLabel: string | null;
    taxBps: number | null;
    subtotalPaise: bigint;
    discountPaise: bigint;
    taxablePaise: bigint;
    taxPaise: bigint;
    totalPaise: bigint;
  };
  items: ReadonlyArray<{ position: number; serviceNameSnapshot: string; unitLabel: string; qty: number; unitPricePaise: bigint; lineTotalPaise: bigint }>;
  document: DocumentSnapshot;
};

export type QuoteRenderLine = { position: number; name: string; unitLabel: string; qty: number; unitPrice: string; lineTotal: string };

export type QuoteRenderModel = {
  schemaVersion: 1;
  quoteNumber: string;
  versionNo: number;
  versionLabel: string;
  issuedAtIso: string;
  issuedOn: string;
  validUntilIso: string;
  validUntil: string;
  timeZone: string;
  sender: { name: string; gstin: string | null; brandColor: string; termsText: string | null };
  recipient: { name: string };
  lines: QuoteRenderLine[];
  totals: {
    subtotal: string;
    discount: string | null;
    discountLabel: string | null;
    taxable: string | null;
    tax: string | null;
    taxLabel: string | null;
    total: string;
  };
  scopeText: string;
  timelineText: string;
  notice: string;
  watermark: string | null;
  contentHash: string;
  shortHash: string;
};

export function quoteWatermark(mode: 'demo' | 'live'): string | null {
  return mode === 'demo' ? DEMO_WATERMARK : null;
}

/** `1000` -> `10%`, `1250` -> `12.5%`, `1825` -> `18.25%`. */
export function formatBpsPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = String(Math.abs(bps % 100)).padStart(2, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''}%`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function buildQuoteRenderModel(src: RenderSource, opts: { mode: 'demo' | 'live' }): QuoteRenderModel {
  const v = src.version;
  const doc = src.document;
  const timeZone = doc.timeZone || DEFAULT_TIMEZONE;
  const hasDiscount = v.discountPaise > 0n;
  const hasTax = v.taxBps !== null;
  const content = {
    schemaVersion: 1 as const,
    quoteNumber: src.quoteNumber,
    versionNo: v.versionNo,
    versionLabel: `v${v.versionNo}`,
    issuedAtIso: v.createdAt.toISOString(),
    issuedOn: formatDate(v.createdAt, timeZone),
    validUntilIso: v.validUntil.toISOString(),
    validUntil: formatDate(v.validUntil, timeZone),
    timeZone,
    sender: { name: doc.senderName, gstin: doc.gstin, brandColor: HEX_COLOR.test(doc.brandColor) ? doc.brandColor : DEFAULT_BRAND, termsText: doc.termsText },
    recipient: { name: doc.recipientName },
    lines: [...src.items]
      .sort((a, b) => a.position - b.position)
      .map((i) => ({ position: i.position, name: i.serviceNameSnapshot, unitLabel: i.unitLabel, qty: i.qty, unitPrice: formatINR(i.unitPricePaise), lineTotal: formatINR(i.lineTotalPaise) })),
    totals: {
      subtotal: formatINR(v.subtotalPaise),
      discount: hasDiscount ? formatINR(v.discountPaise) : null,
      discountLabel: hasDiscount ? (v.discountKind === 'PERCENT_BPS' ? `Discount (${formatBpsPercent(Number(v.discountValue))})` : 'Discount') : null,
      taxable: hasTax ? formatINR(v.taxablePaise) : null,
      tax: hasTax ? formatINR(v.taxPaise) : null,
      taxLabel: hasTax ? `${v.taxLabel ?? 'Tax'} (${formatBpsPercent(v.taxBps!)})` : null,
      total: formatINR(v.totalPaise),
    },
    scopeText: v.scopeText,
    timelineText: v.timelineText,
    notice: QUOTE_NOTICE,
  };
  const contentHash = createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex');
  return { ...content, watermark: quoteWatermark(opts.mode), contentHash, shortHash: contentHash.slice(0, 12) };
}

// ---- Loading -------------------------------------------------------------------------------------

type ReadDb = Pick<PrismaClient, 'quoteVersion' | 'quote' | 'workspace' | 'workspaceSettings' | 'lead'> | Pick<Prisma.TransactionClient, 'quoteVersion' | 'quote' | 'workspace' | 'workspaceSettings' | 'lead'>;

/** The document facts of a version, read from the workspace, its settings and the lead. */
export async function readDocumentSnapshot(db: ReadDb, input: { workspaceId: string; leadId: string }): Promise<DocumentSnapshot> {
  const d = db as PrismaClient;
  const [workspace, settings, lead] = await Promise.all([
    d.workspace.findUnique({ where: { id: input.workspaceId }, select: { name: true, timezone: true } }),
    d.workspaceSettings.findUnique({ where: { workspaceId: input.workspaceId }, select: { brandColor: true, termsText: true, gstin: true } }),
    d.lead.findFirst({ where: { id: input.leadId, workspaceId: input.workspaceId }, select: { displayName: true } }),
  ]);
  if (!workspace || !lead) throw new NotFoundError({ message: 'quote document facts not found' });
  return {
    senderName: workspace.name,
    timeZone: workspace.timezone,
    brandColor: settings?.brandColor ?? DEFAULT_BRAND,
    termsText: settings?.termsText?.trim() ? settings.termsText : null,
    gstin: settings?.gstin ?? null,
    recipientName: lead.displayName,
  };
}

function snapshotDocument(snapshot: Prisma.JsonValue): DocumentSnapshot | null {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return null;
  const doc = (snapshot as Prisma.JsonObject).document;
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return null;
  const o = doc as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : null);
  if (str('senderName') === null || str('recipientName') === null) return null;
  return {
    senderName: str('senderName')!,
    timeZone: str('timeZone') ?? DEFAULT_TIMEZONE,
    brandColor: str('brandColor') ?? DEFAULT_BRAND,
    termsText: str('termsText'),
    gstin: str('gstin'),
    recipientName: str('recipientName')!,
  };
}

/** The version snapshot with the document facts added (written by the versioning service). */
export function withDocumentSnapshot(snapshot: Prisma.InputJsonObject, document: DocumentSnapshot): Prisma.InputJsonObject {
  return { ...snapshot, document };
}

export async function loadRenderSource(db: ReadDb, input: { workspaceId: string; quoteVersionId: string }): Promise<RenderSource & { quoteId: string; leadId: string }> {
  const d = db as PrismaClient;
  const version = await d.quoteVersion.findFirst({
    where: { id: input.quoteVersionId, workspaceId: input.workspaceId },
    include: { items: { orderBy: { position: 'asc' } }, quote: { select: { id: true, number: true, leadId: true } } },
  });
  if (!version) throw new NotFoundError({ message: 'quote version not found' });
  const document = snapshotDocument(version.snapshot) ?? (await readDocumentSnapshot(db, { workspaceId: input.workspaceId, leadId: version.quote.leadId }));
  return { quoteId: version.quote.id, leadId: version.quote.leadId, quoteNumber: version.quote.number, version, items: version.items, document };
}

export async function loadQuoteRenderModel(db: ReadDb, input: { workspaceId: string; quoteVersionId: string }, mode: 'demo' | 'live'): Promise<QuoteRenderModel> {
  return buildQuoteRenderModel(await loadRenderSource(db, input), { mode });
}
