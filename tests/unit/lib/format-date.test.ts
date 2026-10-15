import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMEZONE, formatDate, formatDateTime, formatUtcIso } from '@/lib/format/date';

const AT = new Date('2026-10-15T20:00:00.000Z'); // 16 Oct 01:30 IST, 15 Oct 16:00 New York

describe('date formatting (stored UTC, displayed in the workspace zone)', () => {
  it('defaults to Asia/Kolkata regardless of the host zone', () => {
    expect(DEFAULT_TIMEZONE).toBe('Asia/Kolkata');
    expect(process.env.TZ).toBe('America/New_York');
    expect(formatDate(AT)).toBe('16 Oct 2026');
    expect(formatDateTime(AT)).toBe('16 Oct 2026, 1:30 am IST');
  });

  it('formats in another explicit zone', () => {
    expect(formatDate(AT, 'America/New_York')).toBe('15 Oct 2026');
    expect(formatDateTime(AT, 'UTC')).toBe('15 Oct 2026, 8:00 pm UTC');
  });

  it('formats UTC ISO strings exactly', () => {
    expect(formatUtcIso(AT)).toBe('2026-10-15T20:00:00.000Z');
  });

  it('rejects invalid dates and zones', () => {
    expect(() => formatDate(new Date('nope'))).toThrow(RangeError);
    expect(() => formatDate(AT, 'Mars/Olympus')).toThrow(RangeError);
  });
});
