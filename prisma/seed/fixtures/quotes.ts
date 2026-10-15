/**
 * Demo quotes (T15). One fictitious lead per listed workspace with a DRAFT quote v1 priced from
 * that workspace's seeded price list v1, with its PENDING approval and `quote.create` audit row,
 * exactly as `createQuote` writes them. Totals here are the plan §8 math on the seeded prices and
 * are asserted against `computeQuoteTotals` by tests/integration/quotes/seed-quotes.test.ts.
 *
 * Only workspace B (ironpulse-fitness, the tenant-matrix target) gets one, so the matrix probes a
 * real foreign quote. Times are relative to the seed anchor and re-based by demo:refresh
 * (prisma/seed/rebase.ts); nothing anchor-relative is stored inside JSON.
 */

export type QuoteFixture = {
  key: string;
  workspace: string;
  ownerKey: string;
  lead: { name: string; city: string; category: string; createdDaysAgo: number };
  number: string;
  createdDaysAgo: number;
  /** Seeded service codes and quantities; prices come from the workspace fixture. */
  items: Array<{ code: string; qty: number }>;
  scopeText: string;
  timelineText: string;
};

export const QUOTE_FIXTURES: readonly QuoteFixture[] = [
  {
    key: 'ironpulse-fitness:Q-0001',
    workspace: 'ironpulse-fitness',
    ownerKey: 'rohan',
    lead: { name: 'Kunal Deshpande', city: 'Mumbai', category: 'Personal training', createdDaysAgo: 3 },
    number: 'Q-0001',
    createdDaysAgo: 2,
    items: [{ code: 'PT-12', qty: 1 }],
    scopeText: 'Twelve one-to-one strength sessions with a certified coach, including a starting assessment.',
    timelineText: 'Six weeks, two sessions a week',
  },
];
