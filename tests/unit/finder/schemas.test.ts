// ADR-118 (slice F1, plan §5 caps): the start request trims and de-duplicates keywords and
// locations (case-insensitively), allows at most 10 of each, results per search of 20, 40 or 60
// only, and an email blacklist of addresses or domains; the results query reads its filters as
// flags on the real columns.
import { describe, expect, it } from 'vitest';
import { FinderResultsQuery, ImportFinderResultsBody, StartFinderRunBody } from '@/server/services/lead-finder/schemas';

const base = { requestKey: 'finder-schema-0001', keywords: ['gym'], locations: ['Indore'], maxPerQuery: 20 };

describe('StartFinderRunBody', () => {
  it('normalizes the terms and defaults the email options', () => {
    const parsed = StartFinderRunBody.parse({ ...base, keywords: ['  Dental   clinic ', 'dental clinic', '', 'Gym'], locations: ['Indore', 'INDORE', 'Bhopal'] });
    expect(parsed).toMatchObject({ keywords: ['Dental clinic', 'Gym'], locations: ['Indore', 'Bhopal'], extractEmails: false, emailBlacklist: [] });
  });

  it('allows at most 10 keywords and 10 locations, and needs one of each', () => {
    const many = Array.from({ length: 11 }, (_, i) => `term ${i}`);
    expect(StartFinderRunBody.safeParse({ ...base, keywords: many }).success).toBe(false);
    expect(StartFinderRunBody.safeParse({ ...base, locations: many }).success).toBe(false);
    expect(StartFinderRunBody.safeParse({ ...base, keywords: many.slice(0, 10), locations: many.slice(0, 10) }).success).toBe(true);
    expect(StartFinderRunBody.safeParse({ ...base, keywords: ['  '] }).success).toBe(false);
    expect(StartFinderRunBody.safeParse({ ...base, keywords: ['x'.repeat(81)] }).success).toBe(false);
  });

  it('takes 20, 40 or 60 results per search only', () => {
    for (const n of [20, 40, 60]) expect(StartFinderRunBody.safeParse({ ...base, maxPerQuery: n }).success).toBe(true);
    for (const n of [0, 10, 30, 80, '20']) expect(StartFinderRunBody.safeParse({ ...base, maxPerQuery: n }).success).toBe(false);
  });

  it('keeps blacklist entries that are addresses or domains, lower-cased', () => {
    expect(StartFinderRunBody.parse({ ...base, emailBlacklist: ['Gmail.com', '@yahoo.co.in', 'Info@Shop.in', 'gmail.com'] }).emailBlacklist).toEqual(['gmail.com', 'yahoo.co.in', 'info@shop.in']);
    expect(StartFinderRunBody.safeParse({ ...base, emailBlacklist: ['not a domain'] }).success).toBe(false);
  });

  it('needs a well-formed request key', () => {
    expect(StartFinderRunBody.safeParse({ ...base, requestKey: 'short' }).success).toBe(false);
    expect(StartFinderRunBody.safeParse({ ...base, requestKey: 'has spaces in it' }).success).toBe(false);
  });
});

describe('the other shapes', () => {
  it('imports at most 200 results per request', () => {
    expect(ImportFinderResultsBody.safeParse({ requestKey: 'finder-import-01', resultIds: Array.from({ length: 201 }, (_, i) => `r${i}`) }).success).toBe(false);
    expect(ImportFinderResultsBody.safeParse({ requestKey: 'finder-import-01', resultIds: [] }).success).toBe(false);
  });

  it('reads filters as flags and the page as a number', () => {
    expect(FinderResultsQuery.parse({ noWebsite: '1', hasPhone: 'true', page: '3' })).toMatchObject({ noWebsite: true, hasPhone: true, notImported: false, page: 3 });
    expect(FinderResultsQuery.safeParse({ page: '0' }).success).toBe(false);
    expect(FinderResultsQuery.safeParse({ noWebsite: 'yes' }).success).toBe(false);
  });
});
