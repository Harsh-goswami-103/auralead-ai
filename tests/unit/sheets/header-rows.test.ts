/**
 * T34 pure parts of the Sheets reader (ADR-103): header analysis (normalized names, duplicates, the
 * event id column, an order-insensitive fingerprint, the column diff shown on drift), Sheets serial
 * dates in the spreadsheet's time zone, weak content-hash row ids, and turning API rows into push
 * rows (mapped columns only, the event id as the row key, empty rows and rows still waiting for
 * their id counted, not ingested).
 */
import { describe, expect, it } from 'vitest';
import { analyzeHeader, columnDiff, headerFingerprint } from '@/server/services/sheets/header';
import { rowsFromValues, serialToIso, weakRowKey } from '@/server/services/sheets/rows';

describe('header', () => {
  it('normalizes names, ignores empty cells and the event id column, and finds duplicates', () => {
    const h = analyzeHeader(['Timestamp', ' Full   name ', '', 'Phone number', 'auralead_event_id', 'Full name']);
    expect(h.columns).toEqual(['Timestamp', 'Full name', '', 'Phone number', 'auralead_event_id', 'Full name']);
    expect(h.names).toEqual(['Timestamp', 'Full name', 'Phone number']);
    expect(h.duplicates).toEqual(['Full name']);
    expect(h.eventIdIndex).toBe(4);
  });

  it('fingerprints the set of names: order, spacing and the event id column do not count; a rename does', () => {
    const a = analyzeHeader(['Timestamp', 'Full name', 'Phone number']).fingerprint;
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(analyzeHeader(['Phone number', ' Full  name', 'Timestamp', 'auralead_event_id']).fingerprint).toBe(a);
    expect(analyzeHeader(['Timestamp', 'Name', 'Phone number']).fingerprint).not.toBe(a);
    expect(headerFingerprint(['Timestamp', 'Full name', 'Phone number'])).toBe(a);
  });

  it('diffs columns', () => {
    expect(columnDiff(['Timestamp', 'Full name', 'Phone number'], ['Timestamp', 'Name', 'Phone number', 'City'])).toEqual({ added: ['Name', 'City'], removed: ['Full name'] });
  });
});

describe('rows', () => {
  it('converts a serial date in the spreadsheet time zone to an instant', () => {
    // 2026-10-20 10:30:00 in Asia/Kolkata is 05:00Z. Serial days since 1899-12-30.
    const serial = 46315 + 10.5 / 24;
    expect(serialToIso(serial, 'Asia/Kolkata')).toBe('2026-10-20T05:00:00.000Z');
    expect(serialToIso(serial, 'UTC')).toBe('2026-10-20T10:30:00.000Z');
    // New York in October is UTC-4.
    expect(serialToIso(serial, 'America/New_York')).toBe('2026-10-20T14:30:00.000Z');
    expect(serialToIso(serial, 'Not/AZone')).toBeUndefined();
    expect(serialToIso(Number.NaN, 'UTC')).toBeUndefined();
  });

  it('weak ids are stable for the same content and change when the content does', () => {
    const a = weakRowKey({ 'Full name': 'Asha', Phone: '9810000001' }, '2026-10-20T05:00:00.000Z');
    expect(a).toMatch(/^weak:[0-9a-f]{40}$/);
    expect(weakRowKey({ Phone: '9810000001', 'Full name': 'Asha' }, '2026-10-20T05:00:00.000Z')).toBe(a);
    expect(weakRowKey({ 'Full name': 'Asha', Phone: '9810000002' }, '2026-10-20T05:00:00.000Z')).not.toBe(a);
  });

  const header = analyzeHeader(['Timestamp', 'Full name', 'Phone number', 'Notes', 'WhatsApp', 'auralead_event_id']);
  const columns = new Set(['Timestamp', 'Full name', 'Phone number', 'WhatsApp']);

  it('keys values by mapped column, uses the event id cell as the row key, and stops the cursor at a row still waiting for its id', () => {
    const serial = 46315 + 10.5 / 24;
    const out = rowsFromValues(
      header,
      [
        [serial, 'Asha', 919810000001, 'private', 'Yes', 'id-1'],
        [],
        [serial, 'Bina', '9810000002', '', 'No'],
        [serial, 'Chitra', '9810000003', '', 'Yes', 'id-4'],
      ],
      { firstRowNumber: 2, submittedAtColumn: 'Timestamp', timeZone: 'Asia/Kolkata', columns },
    );
    expect(out.records).toEqual([
      { rowNumber: 2, rowKey: 'id-1', weakId: false, submittedAt: '2026-10-20T05:00:00.000Z', values: { Timestamp: serial, 'Full name': 'Asha', 'Phone number': 919810000001, WhatsApp: 'Yes' } },
      { rowNumber: 5, rowKey: 'id-4', weakId: false, submittedAt: '2026-10-20T05:00:00.000Z', values: { Timestamp: serial, 'Full name': 'Chitra', 'Phone number': '9810000003', WhatsApp: 'Yes' } },
    ]);
    expect(out.emptyRows).toEqual([3]);
    expect(out.pendingRows).toEqual([4]);
    expect(out.cursorRow).toBe(3);
  });

  it('without an event id column every row gets a flagged weak id and the cursor passes the last row read', () => {
    const plain = analyzeHeader(['Full name', 'Phone number']);
    const out = rowsFromValues(plain, [['Asha', '9810000001'], ['Bina', '9810000002']], { firstRowNumber: 2, submittedAtColumn: null, timeZone: 'UTC', columns: new Set(['Full name', 'Phone number']) });
    expect(out.records.map((r) => [r.rowNumber, r.weakId, r.rowKey.startsWith('weak:')])).toEqual([
      [2, true, true],
      [3, true, true],
    ]);
    expect(out.cursorRow).toBe(3);
  });
});
