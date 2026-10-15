/**
 * Demo shared quote (T16): one quote that has been revised, approved, sent and shared, so the
 * public page at /quote/[token] can be opened in DEMO without any setup, and so the public quote
 * E2E spec has every share state to work with:
 *   - the current link (version 2, SENT): the live page with the acceptance form;
 *   - a link to version 1, superseded when version 2 was issued: 410 naming the sender;
 *   - a revoked link to version 2: the 404 page.
 *
 * DEMO only (the seed refuses LIVE targets). The share tokens are derived deterministically from
 * a fixed label (`demoShareToken`) so a reseed reproduces them; only their sha256 is stored, as for
 * every link. Totals are the plan §8 math on the workspace's seeded price list v1. Times are
 * relative to the seed anchor and re-based by demo:refresh (prisma/seed/rebase.ts).
 */
import { createHash } from 'node:crypto';
import type { Prisma } from '../../../src/generated/prisma/client';
import { computeQuoteTotals as computeQuoteMoney } from '../../../src/lib/money';
import { seedId } from '../ids';
import { termsFor, WORKSPACE_FIXTURES } from './workspaces';

type Tx = Prisma.TransactionClient;

const DAY = 86_400_000;

export const SHARED_QUOTE_KEY = 'nestkey-realty:Q-0001';
const WORKSPACE = 'nestkey-realty';
/** Kavya Reddy, OWNER of nestkey-realty (fixtures/identities.ts). */
export const SHARED_QUOTE_OWNER = 'kavya';

/** The deterministic DEMO share token for a label (43-char base64url of 32 bytes, like generateToken). */
export function demoShareToken(label: 'current' | 'superseded' | 'revoked'): string {
  return createHash('sha256').update(`auralead-demo-share:${SHARED_QUOTE_KEY}:${label}`, 'utf8').digest('base64url');
}

const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

export const SHARED_QUOTE_FIXTURE = {
  lead: { name: 'Meera Iyer', city: 'Bengaluru', category: 'Residential rental', createdDaysAgo: 8 },
  number: 'Q-0001',
  v1: { createdDaysAgo: 6, items: [{ code: 'RENT-LIST', qty: 1 }], scopeText: 'Rental listing on partner portals with a verified tenant shortlist.', timelineText: 'Three weeks' },
  v2: {
    createdDaysAgo: 4,
    items: [
      { code: 'RENT-LIST', qty: 1 },
      { code: 'SITE-VISIT', qty: 2 },
    ],
    scopeText: 'Rental listing on partner portals with a verified tenant shortlist, plus two accompanied site visits.',
    timelineText: 'Three weeks, visits in the first ten days',
  },
} as const;

export async function insertSharedQuotes(tx: Tx, now: Date): Promise<void> {
  const users = { ownerId: seedId('user', SHARED_QUOTE_OWNER) };
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const ws = WORKSPACE_FIXTURES.find((w) => w.slug === WORKSPACE);
  if (!ws) throw new Error(`seed fixture error: unknown workspace ${WORKSPACE}`);
  const f = SHARED_QUOTE_FIXTURE;
  const wsId = seedId('workspace', ws.slug);
  const leadId = seedId('lead', SHARED_QUOTE_KEY);
  const quoteId = seedId('quote', SHARED_QUOTE_KEY);
  const pricingVersionId = seedId('pricing-version', `${ws.slug}:1`);
  const tax = ws.settings.taxMode === 'CONFIGURED' && ws.settings.taxBps !== null ? ({ mode: 'CONFIGURED', bps: ws.settings.taxBps } as const) : ({ mode: 'NONE' } as const);
  const document = { senderName: ws.name, timeZone: 'Asia/Kolkata', brandColor: ws.settings.brandColor, termsText: termsFor(ws), gstin: null, recipientName: f.lead.name };

  await tx.lead.create({
    data: {
      id: leadId,
      workspaceId: wsId,
      displayName: f.lead.name,
      nameNormalized: f.lead.name.toLowerCase(),
      category: f.lead.category,
      city: f.lead.city,
      alternatePhones: [],
      scoreReasons: [],
      unknownInputs: [],
      firstSource: 'MANUAL',
      salesStage: 'QUOTE_SENT',
      createdAt: ago(f.lead.createdDaysAgo),
      updatedAt: ago(f.v2.createdDaysAgo),
    },
  });
  await tx.quote.create({ data: { id: quoteId, workspaceId: wsId, leadId, number: f.number, status: 'DRAFT', createdBy: users.ownerId, createdAt: ago(f.v1.createdDaysAgo), updatedAt: ago(f.v1.createdDaysAgo) } });

  const versionIds: string[] = [];
  for (const [index, v] of [f.v1, f.v2].entries()) {
    const versionNo = index + 1;
    const versionId = seedId('quote-version', `${SHARED_QUOTE_KEY}:${versionNo}`);
    versionIds.push(versionId);
    const createdAt = ago(v.createdDaysAgo);
    const lines = v.items.map((item, position) => {
      const svc = ws.services.find((s) => s.code === item.code);
      if (!svc) throw new Error(`seed fixture error: unknown service ${item.code}`);
      return { svc, qty: item.qty, unitPricePaise: BigInt(svc.unitPriceRupees) * 100n, position };
    });
    const money = computeQuoteMoney({ lines, discount: { kind: 'NONE', value: 0n }, tax });
    const limit = lines.reduce<number>((min, l) => (l.svc.maxDiscountBps === null ? min : Math.min(min, l.svc.maxDiscountBps)), ws.settings.maxDiscountBps);
    await tx.quoteVersion.create({
      data: {
        id: versionId,
        workspaceId: wsId,
        quoteId,
        versionNo,
        pricingVersionId,
        snapshot: {
          pricingVersionId,
          pricingVersion: 1,
          services: lines.map((l) => ({
            serviceId: seedId('service', `${ws.slug}:${l.svc.code}`),
            code: l.svc.code,
            name: l.svc.name,
            unitLabel: l.svc.unitLabel,
            unitPricePaise: l.unitPricePaise.toString(),
            minQty: l.svc.minQty ?? 1,
            maxQty: l.svc.maxQty ?? 10000,
            maxDiscountBps: l.svc.maxDiscountBps,
          })),
          rules: {
            workspaceMaxDiscountBps: ws.settings.maxDiscountBps,
            effectiveDiscountLimitBps: limit,
            taxMode: tax.mode,
            taxLabel: tax.mode === 'CONFIGURED' ? ws.settings.taxLabel : null,
            taxBps: tax.mode === 'CONFIGURED' ? tax.bps : null,
            quoteValidityDays: ws.settings.quoteValidityDays,
            gstin: null,
            sanityCapPaise: '100000000000',
          },
          document,
        },
        scopeText: v.scopeText,
        timelineText: v.timelineText,
        discountKind: 'NONE',
        discountValue: 0n,
        taxLabel: tax.mode === 'CONFIGURED' ? ws.settings.taxLabel : null,
        taxBps: tax.mode === 'CONFIGURED' ? tax.bps : null,
        subtotalPaise: money.subtotalPaise,
        discountPaise: money.discountPaise,
        taxablePaise: money.taxablePaise,
        taxPaise: money.taxPaise,
        totalPaise: money.totalPaise,
        validUntil: new Date(createdAt.getTime() + ws.settings.quoteValidityDays * DAY),
        sentAt: createdAt,
        aiPolicyFlags: [],
        reviewReasons: [],
        createdBy: users.ownerId,
        createdAt,
        items: {
          create: lines.map((l, i) => ({
            id: seedId('quote-item', `${SHARED_QUOTE_KEY}:${versionNo}:${l.position}`),
            serviceId: seedId('service', `${ws.slug}:${l.svc.code}`),
            serviceNameSnapshot: l.svc.name,
            unitLabel: l.svc.unitLabel,
            qty: l.qty,
            unitPricePaise: l.unitPricePaise,
            lineTotalPaise: money.lines[i]!.lineTotalPaise,
            position: l.position,
          })),
        },
      },
    });
  }

  const [v1Id, v2Id] = versionIds as [string, string];
  const v1At = ago(f.v1.createdDaysAgo);
  const v2At = ago(f.v2.createdDaysAgo);
  const v2ValidUntil = new Date(v2At.getTime() + ws.settings.quoteValidityDays * DAY);
  await tx.quote.update({
    where: { id: quoteId },
    data: { status: 'SENT', sentVia: 'MANUAL_LINK', currentVersionId: v2Id, currentVersionNo: 2, validUntil: v2ValidUntil, needsPricingReview: false, updatedAt: v2At },
  });
  await tx.approval.create({
    data: { id: seedId('approval', `${SHARED_QUOTE_KEY}:1`), workspaceId: wsId, kind: 'QUOTE_VERSION', status: 'INVALIDATED', quoteId, quoteVersionId: v1Id, flags: [], requestedAt: v1At, decidedBy: users.ownerId, decidedAt: v1At, invalidatedAt: v2At, invalidationReason: 'QUOTE_REVISED' },
  });
  await tx.approval.create({
    data: { id: seedId('approval', `${SHARED_QUOTE_KEY}:2`), workspaceId: wsId, kind: 'QUOTE_VERSION', status: 'APPROVED', quoteId, quoteVersionId: v2Id, flags: [], requestedAt: v2At, decidedBy: users.ownerId, decidedAt: v2At },
  });

  const shares = [
    { label: 'superseded' as const, versionId: v1Id, createdAt: v1At, expiresAt: new Date(v1At.getTime() + ws.settings.quoteValidityDays * DAY), supersededAt: v2At, revokedAt: null },
    { label: 'current' as const, versionId: v2Id, createdAt: v2At, expiresAt: v2ValidUntil, supersededAt: null, revokedAt: null },
    { label: 'revoked' as const, versionId: v2Id, createdAt: v2At, expiresAt: v2ValidUntil, supersededAt: null, revokedAt: v2At },
  ];
  for (const s of shares) {
    await tx.quoteShare.create({
      data: {
        id: seedId('quote-share', `${SHARED_QUOTE_KEY}:${s.label}`),
        workspaceId: wsId,
        quoteId,
        quoteVersionId: s.versionId,
        tokenHash: tokenHash(demoShareToken(s.label)),
        expiresAt: s.expiresAt,
        revokedAt: s.revokedAt,
        supersededAt: s.supersededAt,
        createdBy: users.ownerId,
        createdAt: s.createdAt,
      },
    });
  }

  const audit = [
    { key: 'quote.create', action: 'quote.create', at: v1At, summary: { number: f.number, versionNo: 1, lines: 1, unpriced: 0, needsPricingReview: false, pricingVersion: 1, fromDraft: false, aiPolicyFlags: [] } },
    { key: 'quote.approve:1', action: 'quote.approve', at: v1At, summary: { versionNo: 1 } },
    { key: 'quote.revise', action: 'quote.revise', at: v2At, summary: { fromStatus: 'SENT', versionNo: 2, lines: 2, unpriced: 0, needsPricingReview: false, pricingVersion: 1, repriced: false, supersededShares: 1 } },
    { key: 'quote.approve:2', action: 'quote.approve', at: v2At, summary: { versionNo: 2 } },
    { key: 'quote.sent', action: 'quote.sent', at: v2At, summary: { versionNo: 2, sentVia: 'MANUAL_LINK' } },
  ];
  for (const [i, a] of audit.entries()) {
    await tx.auditEvent.create({
      data: {
        id: seedId('audit', `${a.key}:${SHARED_QUOTE_KEY}`),
        workspaceId: wsId,
        actorUserId: users.ownerId,
        actorKind: 'USER',
        action: a.action,
        targetType: 'Quote',
        targetId: quoteId,
        result: 'SUCCESS',
        summary: a.summary,
        crossWorkspace: false,
        correlationId: 'seed',
        simulated: true,
        createdAt: new Date(a.at.getTime() + i * 1000),
      },
    });
  }
}
