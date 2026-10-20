// T26, R31 (plan §11 M4): the Leads list reads through the tenant-scoped context. Search runs on
// the normalized columns (name with case, accents and punctuation folded, Devanagari included;
// phone digits, ASCII or Devanagari; email), filters narrow by stage, source and score band, and
// pages are keyset pages of 50 in a stable order (the 50/51 boundary), forward and back, including
// across the unscored leads at the end of a score sort. Counts stop at 1,000 and say so. Merged
// leads and other workspaces never appear. The Kanban board lists each stage's newest cards with a
// capped per-stage count.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEAD_COUNT_CAP, LEAD_PAGE_SIZE, parseLeadPageParams, type LeadListParams } from '@/lib/schemas/leads';
import { listLeads, loadLeadBoard } from '@/server/services/leads/list';
import { createQuoteHarness, makeLeads, ownerCtx, userCtx, WS_A, WS_B, WS_KESARI, type QuoteHarness } from './support';

let h: QuoteHarness;

beforeAll(async () => {
  h = await createQuoteHarness('lead-list');
}, 120_000);

afterAll(async () => {
  await h?.testDb.destroy();
});

const params = (p: Partial<LeadListParams> = {}): LeadListParams => ({ sort: 'newest', dir: 'next', ...p });

describe('keyset pages of 50', () => {
  it('51 leads: 50 then 1, and back again; 50 leads: one page', async () => {
    // Kesari has no seeded leads, so every row here is ours.
    const made = await makeLeads(h.db, WS_KESARI, Array.from({ length: 51 }, (_, i) => ({ name: `Paging Lead ${String(i + 1).padStart(2, '0')}` })));
    const pooja = await userCtx(h.db, h.clock, 'pooja');

    const first = await listLeads(pooja, params());
    expect(LEAD_PAGE_SIZE).toBe(50);
    expect(first.rows).toHaveLength(50);
    expect(first.total).toEqual({ count: 51, capped: false });
    expect(first.rows[0]!.displayName).toBe('Paging Lead 51');
    expect(first.prevCursor).toBeNull();
    expect(first.nextCursor).not.toBeNull();

    const second = await listLeads(pooja, params({ cursor: first.nextCursor! }));
    expect(second.rows.map((r) => r.displayName)).toEqual(['Paging Lead 01']);
    expect(second.nextCursor).toBeNull();
    expect(second.prevCursor).not.toBeNull();

    const back = await listLeads(pooja, params({ cursor: second.prevCursor!, dir: 'prev' }));
    expect(back.rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id));
    expect(back.prevCursor).toBeNull();
    expect(back.nextCursor).toBe(first.nextCursor);

    // Exactly 50: one page, no next.
    await h.db.lead.update({ where: { id: made[0]!.id }, data: { salesStage: 'LOST' } });
    const fifty = await listLeads(pooja, params({ stage: 'NEW' }));
    expect(fifty.rows).toHaveLength(50);
    expect(fifty.total).toEqual({ count: 50, capped: false });
    expect(fifty.nextCursor).toBeNull();
  });

  it('the score sort pages through scored leads, then the unscored ones, in both directions', async () => {
    const ws = WS_B;
    const scored = Array.from({ length: 30 }, (_, i) => ({ name: `Score Sort ${i}`, score: i % 10 === 0 ? 55 : 20 + i }));
    const unscored = Array.from({ length: 30 }, (_, i) => ({ name: `Unscored Sort ${i}`, score: null }));
    await makeLeads(h.db, ws, [...scored, ...unscored]);
    const rohan = await userCtx(h.db, h.clock, 'rohan');
    const p1 = await listLeads(rohan, params({ sort: 'score', q: 'sort' }), { pageSize: 25 });
    const p2 = await listLeads(rohan, params({ sort: 'score', q: 'sort', cursor: p1.nextCursor! }), { pageSize: 25 });
    const p3 = await listLeads(rohan, params({ sort: 'score', q: 'sort', cursor: p2.nextCursor! }), { pageSize: 25 });
    expect(p3.nextCursor).toBeNull();
    const all = [...p1.rows, ...p2.rows, ...p3.rows];
    expect(all).toHaveLength(60);
    expect(new Set(all.map((r) => r.id)).size).toBe(60);
    const scores = all.map((r) => r.score);
    const firstNull = scores.indexOf(null);
    expect(firstNull).toBe(30);
    expect(scores.slice(30).every((s) => s === null)).toBe(true);
    const known = scores.slice(0, 30) as number[];
    expect(known).toEqual([...known].sort((a, b) => b - a));

    // Back from page 3 (all unscored) to page 2 (crosses the null boundary).
    const back = await listLeads(rohan, params({ sort: 'score', q: 'sort', cursor: p3.prevCursor!, dir: 'prev' }), { pageSize: 25 });
    expect(back.rows.map((r) => r.id)).toEqual(p2.rows.map((r) => r.id));
  });

  it('name and oldest sorts are stable keyset orders too', async () => {
    const rohan = await userCtx(h.db, h.clock, 'rohan');
    const byName = await listLeads(rohan, params({ sort: 'name', q: 'unscored sort' }), { pageSize: 7 });
    const next = await listLeads(rohan, params({ sort: 'name', q: 'unscored sort', cursor: byName.nextCursor! }), { pageSize: 7 });
    const names = [...byName.rows, ...next.rows].map((r) => r.displayName);
    expect(names).toEqual([...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), 'en')));
    const oldest = await listLeads(rohan, params({ sort: 'oldest', q: 'score sort' }), { pageSize: 5 });
    expect(oldest.rows[0]!.displayName).toBe('Score Sort 0');
  });
});

describe('search on normalized columns', () => {
  it('finds Devanagari names with or without vowel signs, Latin names regardless of case and accents', async () => {
    await makeLeads(h.db, WS_A, [
      { name: 'राहुल शर्मा', phone: '+919876543210' },
      { name: 'Rahul Sharma', phone: '+919811111111', email: 'rahul.sharma@example.test' },
      { name: 'Zoë Café & Bakery', phone: '+919822222222' },
      { name: 'Priya Iyer', phone: '+919833333333', email: 'priya@iyer-dental.example' },
    ]);
    const owner = await ownerCtx(h);
    const names = async (q: string) => (await listLeads(owner, params({ q }))).rows.map((r) => r.displayName).sort();
    expect(await names('शर्मा')).toEqual(['राहुल शर्मा']);
    expect(await names('राहुल')).toEqual(['राहुल शर्मा']);
    expect(await names('SHARMA')).toEqual(['Rahul Sharma']);
    expect(await names('zoe cafe')).toEqual(['Zoë Café & Bakery']);
    expect(await names('café')).toEqual(['Zoë Café & Bakery']);
    // Phone digits, typed with spaces or in Devanagari digits.
    expect(await names('98765 43210')).toEqual(['राहुल शर्मा']);
    expect(await names('९८७६५')).toEqual(['राहुल शर्मा']);
    // Email fragment.
    expect(await names('iyer-dental')).toEqual(['Priya Iyer']);
    // Wildcards are text, not patterns; punctuation alone matches nothing.
    expect(await names('%')).toEqual([]);
    expect(await names('_')).toEqual([]);
    expect(await names('!!!')).toEqual([]);
  });

  it('the URL parser keeps a Devanagari query and drops invalid values', () => {
    const p = parseLeadPageParams(new URLSearchParams('q=%E0%A4%B6%E0%A4%B0%E0%A5%8D%E0%A4%AE%E0%A4%BE&stage=WON&source=META_ADS&score=high&sort=bogus&cursor=***&view=board'));
    expect(p).toMatchObject({ q: 'शर्मा', stage: undefined, source: 'META_ADS', score: 'high', sort: 'newest', cursor: undefined, view: 'board', dir: 'next' });
  });
});

describe('filters and scope', () => {
  it('stage, source and score band narrow the rows; merged leads and other workspaces never appear', async () => {
    const [target] = await makeLeads(h.db, WS_A, [
      { name: 'Filter Hot', stage: 'REPLIED', source: 'META_ADS', score: 82 },
      { name: 'Filter Warm', stage: 'REPLIED', source: 'GOOGLE_SHEETS', score: 55 },
      { name: 'Filter Cold', stage: 'NEW', source: 'GMAPS_EXTENSION', score: 12 },
      { name: 'Filter Unscored', stage: 'NEW', source: 'GMAPS_EXTENSION', score: null },
    ]);
    await makeLeads(h.db, WS_A, [{ name: 'Filter Merged', stage: 'REPLIED', score: 90, mergedInto: target!.id }]);
    await makeLeads(h.db, WS_B, [{ name: 'Filter Foreign', stage: 'REPLIED', score: 90 }]);
    const owner = await ownerCtx(h);
    const names = async (p: Partial<LeadListParams>) => (await listLeads(owner, params({ q: 'filter', ...p }))).rows.map((r) => r.displayName).sort();
    expect(await names({})).toEqual(['Filter Cold', 'Filter Hot', 'Filter Unscored', 'Filter Warm']);
    expect(await names({ stage: 'REPLIED' })).toEqual(['Filter Hot', 'Filter Warm']);
    expect(await names({ source: 'GMAPS_EXTENSION' })).toEqual(['Filter Cold', 'Filter Unscored']);
    expect(await names({ score: 'high' })).toEqual(['Filter Hot']);
    expect(await names({ score: 'medium' })).toEqual(['Filter Warm']);
    expect(await names({ score: 'low' })).toEqual(['Filter Cold']);
    expect(await names({ score: 'unscored' })).toEqual(['Filter Unscored']);
  });

  it('rows carry what the table and the stage control need', async () => {
    const owner = await ownerCtx(h);
    const { rows } = await listLeads(owner, params({ q: 'filter hot' }));
    expect(rows[0]).toMatchObject({ displayName: 'Filter Hot', salesStage: 'REPLIED', stageVersion: 0, score: 82, firstSource: 'META_ADS', simulated: false });
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
  });

  it('needs leads.read; an employee without an assignment sees nothing', async () => {
    const arjun = await userCtx(h.db, h.clock, 'arjun');
    await expect(listLeads(arjun, params())).rejects.toMatchObject({ status: 404 });
  });
});

describe('capped counts', () => {
  it('stops counting at 1,000 and says so', async () => {
    const ws = WS_B;
    const now = new Date('2026-10-01T00:00:00.000Z');
    await h.db.lead.createMany({
      data: Array.from({ length: LEAD_COUNT_CAP + 5 }, (_, i) => ({
        workspaceId: ws,
        displayName: `Bulk Count ${i}`,
        nameNormalized: `bulk count ${i}`,
        alternatePhones: [],
        scoreReasons: [],
        unknownInputs: [],
        firstSource: 'MANUAL' as const,
        createdAt: new Date(now.getTime() + i),
        updatedAt: now,
      })),
    });
    const rohan = await userCtx(h.db, h.clock, 'rohan');
    const page = await listLeads(rohan, params({ q: 'bulk count' }));
    expect(page.total).toEqual({ count: LEAD_COUNT_CAP, capped: true });
    expect(page.rows).toHaveLength(LEAD_PAGE_SIZE);
  });
});

describe('Kanban board', () => {
  it('one column per stage with its newest cards and a capped count; search applies', async () => {
    await makeLeads(h.db, WS_A, [
      { name: 'Board New A', stage: 'NEW' },
      { name: 'Board New B', stage: 'NEW' },
      { name: 'Board Quote', stage: 'QUOTE_SENT' },
      { name: 'Board Lost', stage: 'LOST' },
    ]);
    const owner = await ownerCtx(h);
    const board = await loadLeadBoard(owner, params({ q: 'board' }));
    expect(board.columns.map((c) => c.stage)).toEqual(['NEW', 'CONTACTED', 'REPLIED', 'QUOTE_SENT', 'CONVERTED', 'LOST']);
    const col = (stage: string) => board.columns.find((c) => c.stage === stage)!;
    expect(col('NEW').rows.map((r) => r.displayName)).toEqual(['Board New B', 'Board New A']);
    expect(col('NEW').total).toEqual({ count: 2, capped: false });
    expect(col('QUOTE_SENT').rows.map((r) => r.displayName)).toEqual(['Board Quote']);
    expect(col('CONTACTED').rows).toEqual([]);
    expect(col('LOST').total.count).toBe(1);
  });
});
