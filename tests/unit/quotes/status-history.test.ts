/**
 * T27 status history polish: a quotation's status path is derived from its audit timeline, one
 * entry per status change (Draft, Approved, Sent, Opened, Accepted, Expired, Cancelled), with who
 * moved it, the version, and how long it stayed in each status. Repeats (a second open, a second
 * send) do not add a step; housekeeping rows (links, PDFs) are not steps. A quote whose validity
 * passed before the sweep ran shows a derived "Expired" step dated at its validity date, marked as
 * derived, exactly like the status badge reads it.
 */
import { describe, expect, it } from 'vitest';
import { deriveStatusHistory, formatSpan } from '@/app/dashboard/user/quotations/status-history';

const t = (iso: string) => new Date(`2026-10-${iso}Z`);
const row = (action: string, at: string, extra: Partial<{ who: string; versionNo: number | null }> = {}) => ({ id: `${action}-${at}`, action, createdAt: t(at), who: extra.who ?? 'Ananya Sharma', versionNo: extra.versionNo ?? 1 });

describe('deriveStatusHistory', () => {
  it('keeps one step per status change with its duration until the next', () => {
    const steps = deriveStatusHistory(
      [
        row('quote.create', '10T10:00:00.000'),
        row('quote.share.create', '10T11:00:00.000'),
        row('quote.approve', '10T12:00:00.000'),
        row('quote.pdf.render', '10T12:01:00.000'),
        row('quote.send', '11T09:00:00.000'),
        row('quote.view', '11T10:00:00.000', { who: 'Customer (quote page)' }),
        row('quote.view', '11T11:00:00.000', { who: 'Customer (quote page)' }),
        row('quote.accept', '12T09:00:00.000', { who: 'Customer (quote page)' }),
      ],
      { effectiveStatus: 'ACCEPTED', validUntil: t('25T00:00:00.000'), now: t('20T00:00:00.000') },
    );
    expect(steps.map((s) => s.status)).toEqual(['DRAFT', 'APPROVED', 'SENT', 'VIEWED', 'ACCEPTED']);
    expect(steps[0]).toMatchObject({ who: 'Ananya Sharma', versionNo: 1, durationMs: 2 * 3_600_000, current: false, derived: false });
    expect(steps[3]!.durationMs).toBe(23 * 3_600_000);
    expect(steps.at(-1)).toMatchObject({ status: 'ACCEPTED', current: true, durationMs: 7 * 86_400_000 + 15 * 3_600_000 });
  });

  it('a revision returns to Draft with the new version', () => {
    const steps = deriveStatusHistory(
      [row('quote.create', '10T10:00:00.000'), row('quote.approve', '10T11:00:00.000'), row('quote.revise', '10T12:00:00.000', { versionNo: 2 }), row('quote.approve', '10T13:00:00.000', { versionNo: 2 })],
      { effectiveStatus: 'APPROVED', validUntil: t('25T00:00:00.000'), now: t('10T14:00:00.000') },
    );
    expect(steps.map((s) => `${s.status}:v${s.versionNo}`)).toEqual(['DRAFT:v1', 'APPROVED:v1', 'DRAFT:v2', 'APPROVED:v2']);
  });

  it('adds a derived Expired step at the validity date when the sweep has not run yet', () => {
    const steps = deriveStatusHistory([row('quote.create', '01T10:00:00.000'), row('quote.approve', '01T11:00:00.000'), row('quote.send', '01T12:00:00.000')], {
      effectiveStatus: 'EXPIRED',
      validUntil: t('16T00:00:00.000'),
      now: t('20T00:00:00.000'),
    });
    expect(steps.map((s) => s.status)).toEqual(['DRAFT', 'APPROVED', 'SENT', 'EXPIRED']);
    expect(steps.at(-1)).toMatchObject({ derived: true, current: true, at: t('16T00:00:00.000'), who: null });
    expect(steps[2]!.durationMs).toBe(t('16T00:00:00.000').getTime() - t('01T12:00:00.000').getTime());
  });

  it('does not add a second Expired step after the sweep wrote one', () => {
    const steps = deriveStatusHistory([row('quote.create', '01T10:00:00.000'), row('quote.approve', '01T11:00:00.000'), row('quote.expire', '16T00:01:00.000', { who: 'Background job' })], {
      effectiveStatus: 'EXPIRED',
      validUntil: t('16T00:00:00.000'),
      now: t('20T00:00:00.000'),
    });
    expect(steps.map((s) => s.status)).toEqual(['DRAFT', 'APPROVED', 'EXPIRED']);
    expect(steps.at(-1)!.derived).toBe(false);
  });
});

describe('formatSpan', () => {
  it('reads in the largest sensible units', () => {
    expect(formatSpan(20_000)).toBe('under a minute');
    expect(formatSpan(5 * 60_000)).toBe('5 min');
    expect(formatSpan(2 * 3_600_000 + 5 * 60_000)).toBe('2 h 5 min');
    expect(formatSpan(3 * 86_400_000 + 4 * 3_600_000)).toBe('3 days 4 h');
    expect(formatSpan(86_400_000)).toBe('1 day');
  });
});
