/**
 * Shared harness for the T26 leads tests: the seeded DEMO DB (workspace A is the dental clinic the
 * owner persona owns; the `employee` persona holds every capability there and a narrower set in
 * kesari-crafts; `pooja` is a MEMBER of kesari-crafts; `neha` reads ironpulse-fitness only), real
 * user contexts built from DB sessions, and a bulk lead factory that writes leads the way
 * ingestion stores them (normalized name, contact columns, score snapshot).
 */
import type { PrismaClient } from '@/generated/prisma/client';
import type { LeadSource, SalesStage, WebsiteStatus } from '@/lib/domain/enums';
import { normalizeName } from '@/server/services/leads/normalize';
import { seedId } from '../../../prisma/seed/ids';

export { createQuoteHarness, userCtx, ownerCtx, workerWith, drain, NOW, SEED_NOW, DAY, WS_A, WS_A_SLUG, WS_B, WS_KESARI_SLUG, type QuoteHarness } from '../quotes/support';

export const WS_KESARI = seedId('workspace', 'kesari-crafts');
export const WS_B_SLUG = 'ironpulse-fitness';

export type LeadSpec = {
  name: string;
  stage?: SalesStage;
  source?: LeadSource;
  score?: number | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  category?: string | null;
  website?: string | null;
  websiteStatus?: WebsiteStatus;
  rating?: number | null;
  reviewCount?: number | null;
  createdAt?: Date;
  mergedInto?: string;
  simulated?: boolean;
};

let phoneSeq = 0;

/** Creates leads in order; createdAt defaults to one minute apart, oldest first, ending at `base`. */
export async function makeLeads(db: PrismaClient, workspaceId: string, specs: readonly LeadSpec[], base = new Date('2026-10-16T05:00:00.000Z')) {
  const out = [];
  for (let i = 0; i < specs.length; i += 1) {
    const s = specs[i]!;
    phoneSeq += 1;
    const createdAt = s.createdAt ?? new Date(base.getTime() - (specs.length - 1 - i) * 60_000);
    out.push(
      await db.lead.create({
        data: {
          workspaceId,
          displayName: s.name,
          nameNormalized: normalizeName(s.name),
          phoneE164: s.phone === undefined ? `+9198${String(70_000_000 + phoneSeq).padStart(8, '0')}` : s.phone,
          emailNormalized: s.email ?? null,
          alternatePhones: [],
          city: s.city ?? null,
          category: s.category ?? null,
          website: s.website ?? null,
          websiteStatus: s.websiteStatus ?? 'UNKNOWN',
          rating: s.rating ?? null,
          reviewCount: s.reviewCount ?? null,
          salesStage: s.stage ?? 'NEW',
          score: s.score === undefined ? null : s.score,
          scoreReasons: [],
          unknownInputs: [],
          firstSource: s.source ?? 'MANUAL',
          simulated: s.simulated ?? false,
          mergedIntoLeadId: s.mergedInto ?? null,
          createdAt,
          updatedAt: createdAt,
        },
      }),
    );
  }
  return out;
}
