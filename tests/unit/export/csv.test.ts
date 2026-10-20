// T26 (plan §9 XSS row, 03-security T11): the leads CSV is RFC 4180 (CRLF rows, quoted cells when
// they hold a comma, quote or line break, quotes doubled) with a UTF-8 BOM so spreadsheet apps read
// Devanagari correctly, and every text cell that starts with = + - @ TAB or CR is prefixed with an
// apostrophe so a spreadsheet never evaluates a lead's name, phone or website as a formula.
import { describe, expect, it } from 'vitest';
import { buildCsv, CSV_FORMULA_PREFIXES, escapeCsvCell, LEAD_CSV_HEADER, leadCsvRow, type LeadCsvSource } from '@/server/services/leads/csv';

describe('escapeCsvCell', () => {
  it('prefixes every formula trigger with an apostrophe', () => {
    expect(CSV_FORMULA_PREFIXES).toEqual(['=', '+', '-', '@', '\t', '\r']);
    expect(escapeCsvCell('=1+1')).toBe("'=1+1");
    expect(escapeCsvCell('+91 98100 12345')).toBe("'+91 98100 12345");
    expect(escapeCsvCell('-2+3')).toBe("'-2+3");
    expect(escapeCsvCell('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
    expect(escapeCsvCell('\t=cmd')).toBe("'\t=cmd");
    // CR also forces quoting (a line break inside a cell).
    expect(escapeCsvCell('\r=cmd')).toBe('"\'\r=cmd"');
  });

  it('quotes a cell with a comma, a quote or a line break and doubles its quotes', () => {
    expect(escapeCsvCell('Sharma, Rahul')).toBe('"Sharma, Rahul"');
    expect(escapeCsvCell('The "Best" Gym')).toBe('"The ""Best"" Gym"');
    expect(escapeCsvCell('line one\nline two')).toBe('"line one\nline two"');
    expect(escapeCsvCell('=HYPERLINK("http://evil.example","Click")')).toBe('"\'=HYPERLINK(""http://evil.example"",""Click"")"');
  });

  it('leaves safe text, Devanagari and numbers as they are', () => {
    expect(escapeCsvCell('Smile Care Dental')).toBe('Smile Care Dental');
    expect(escapeCsvCell('राहुल शर्मा')).toBe('राहुल शर्मा');
    expect(escapeCsvCell('a=b')).toBe('a=b');
    expect(escapeCsvCell(42)).toBe('42');
    expect(escapeCsvCell(4.5)).toBe('4.5');
    expect(escapeCsvCell(true)).toBe('true');
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
    expect(escapeCsvCell('')).toBe('');
  });
});

describe('buildCsv', () => {
  it('writes a BOM, the header and CRLF-terminated rows', () => {
    const csv = buildCsv(['Name', 'Phone'], [
      ['A, B', '+91 1'],
      ['राहुल', null],
    ]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toBe('﻿Name,Phone\r\n"A, B",\'+91 1\r\nराहुल,\r\n');
  });

  it('escapes header cells too', () => {
    expect(buildCsv(['=x'], [])).toBe("﻿'=x\r\n");
  });
});

describe('leadCsvRow', () => {
  const lead: LeadCsvSource = {
    id: 'lead_1',
    displayName: '=HYPERLINK("http://evil.example","x")',
    salesStage: 'QUOTE_SENT',
    score: 72,
    firstSource: 'GMAPS_EXTENSION',
    phoneE164: '+919810012345',
    emailNormalized: 'asha@example.test',
    website: 'https://smile.example',
    websiteStatus: 'PRESENT_UNVERIFIED',
    city: 'Gurugram',
    category: 'Dental clinic',
    address: 'Sector 29, Gurugram',
    rating: 46,
    reviewCount: 120,
    simulated: true,
    createdAt: new Date('2026-10-16T06:00:00.000Z'),
  };

  it('has one cell per header column, with readable labels and escaped values', () => {
    const row = leadCsvRow(lead);
    expect(row).toHaveLength(LEAD_CSV_HEADER.length);
    const line = buildCsv(LEAD_CSV_HEADER, [row]).split('\r\n')[1]!;
    expect(line).toContain('"\'=HYPERLINK(""http://evil.example"",""x"")"');
    expect(line).toContain("'+919810012345");
    expect(line).toContain('Quote sent');
    expect(line).toContain('Maps extension');
    expect(line).toContain('Listed, not checked');
    expect(line).toContain('"Sector 29, Gurugram"');
    expect(line).toContain(',4.6,');
    expect(line).toContain('2026-10-16T06:00:00.000Z');
    expect(line.endsWith(',yes,lead_1')).toBe(true);
  });

  it('writes empty cells for unknown values, never a guessed one', () => {
    const row = leadCsvRow({ ...lead, score: null, phoneE164: null, emailNormalized: null, website: null, rating: null, reviewCount: null, simulated: false });
    const line = buildCsv(LEAD_CSV_HEADER, [row]).split('\r\n')[1]!;
    expect(line).toContain('Quote sent,,Maps extension,,,');
    expect(line.endsWith(',no,lead_1')).toBe(true);
  });
});
