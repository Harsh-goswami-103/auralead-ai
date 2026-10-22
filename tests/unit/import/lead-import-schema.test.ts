/**
 * ADR-120 (slice F2): the pure parts of the file import. Header synonyms suggest a column mapping
 * (exact names first, then the most specific word rule per column, one field per column and one
 * column per field); consent dates are read as day-first Indian dates, ISO dates or Excel serials
 * in the workspace's zone; the attestation text is rendered verbatim with the business name; a
 * notice must name the business and WhatsApp; the per-row external id carries the row number.
 */
import { describe, expect, it } from 'vitest';
import {
  columnLabel,
  consentAttestationText,
  fileImportExternalId,
  IMPORT_MAPPABLE_FIELDS,
  ImportMapping,
  isOwnDataSource,
  LeadImportConfirmBody,
  LeadImportUploadBody,
  mappingOf,
  noticeProblems,
  normalizeHeaderText,
  parseConsentDate,
  parseFileImportExternalId,
  suggestImportMapping,
} from '@/lib/schemas/lead-import';

describe('IMPORT_MAPPABLE_FIELDS', () => {
  it('is the ADR-120 list, in order', () => {
    expect(IMPORT_MAPPABLE_FIELDS).toEqual(['name', 'phone', 'email', 'website', 'address', 'city', 'category', 'rating', 'reviewCount', 'pincode', 'consent', 'consentDate']);
  });
});

describe('suggestImportMapping (header synonyms)', () => {
  it('maps the plain names of every field', () => {
    const header = ['Name', 'Phone', 'Email', 'Website', 'Address', 'City', 'Category', 'Rating', 'Reviews', 'Pincode', 'Consent', 'Consent date'];
    expect(suggestImportMapping(header)).toEqual({ name: 0, phone: 1, email: 2, website: 3, address: 4, city: 5, category: 6, rating: 7, reviewCount: 8, pincode: 9, consent: 10, consentDate: 11 });
  });

  it.each([
    ['Business', 'name'],
    ['Company Name', 'name'],
    ['Shop', 'name'],
    ['Shop name', 'name'],
    ['Contact name', 'name'],
    ['Mobile', 'phone'],
    ['Mobile No.', 'phone'],
    ['WhatsApp', 'phone'],
    ['WhatsApp number', 'phone'],
    ['Contact', 'phone'],
    ['Contact Number', 'phone'],
    ['Number', 'phone'],
    ['Business phone', 'phone'],
    ['E-mail', 'email'],
    ['Mail', 'email'],
    ['Email address', 'email'],
    ['Site', 'website'],
    ['URL', 'website'],
    ['Website URL', 'website'],
    ['Shop address', 'address'],
    ['Full Address', 'address'],
    ['Town', 'city'],
    ['Type', 'category'],
    ['Business type', 'category'],
    ['Stars', 'rating'],
    ['Google rating', 'rating'],
    ['Review count', 'reviewCount'],
    ['Number of reviews', 'reviewCount'],
    ['PIN', 'pincode'],
    ['Pin code', 'pincode'],
    ['ZIP', 'pincode'],
    ['Opt in', 'consent'],
    ['Opt-in', 'consent'],
    ['WhatsApp opt-in', 'consent'],
    ['WhatsApp consent', 'consent'],
    ['Opt-in date', 'consentDate'],
    ['Consented on', 'consentDate'],
  ] as const)('%s -> %s', (header, field) => {
    expect(suggestImportMapping([header])).toEqual({ [field]: 0 });
  });

  it('gives each field one column and each column one field (exact names win)', () => {
    // Our own export header: "Website status" must not take the website field from "Website".
    const header = ['Name', 'Stage', 'Score', 'Source', 'Phone', 'Email', 'Website', 'Website status', 'City', 'Category', 'Address', 'Rating', 'Reviews', 'Added (UTC)', 'Simulated', 'Lead ID'];
    expect(suggestImportMapping(header)).toEqual({ name: 0, phone: 4, email: 5, website: 6, city: 8, category: 9, address: 10, rating: 11, reviewCount: 12 });
  });

  it('does not let a column fall through to a weaker rule when its field is taken', () => {
    // "Email address" is an email column; with email taken it is left unmapped, never the address.
    expect(suggestImportMapping(['Email', 'Email address', 'Phone', 'Alternate phone'])).toEqual({ email: 0, phone: 2 });
  });

  it('ignores blank and unknown headers', () => {
    expect(suggestImportMapping(['', 'Notes', 'Lead owner', 'Date'])).toEqual({});
  });

  it('normalizes width, case and punctuation', () => {
    expect(normalizeHeaderText('  ＥＭＡＩＬ / Mail-ID ')).toBe('email mail id');
    expect(suggestImportMapping(['ＭＯＢＩＬＥ'])).toEqual({ phone: 0 });
  });
});

describe('mapping schema', () => {
  it('drops null entries and refuses negative or huge column indexes', () => {
    expect(mappingOf(ImportMapping.parse({ name: 0, phone: null, email: 2 }))).toEqual({ name: 0, email: 2 });
    expect(ImportMapping.safeParse({ name: -1 }).success).toBe(false);
    expect(ImportMapping.safeParse({ name: 64 }).success).toBe(false);
  });

  it('upload and confirm bodies carry no workspace id and validate their shapes', () => {
    expect(LeadImportUploadBody.safeParse({ requestKey: 'short', fileName: 'a.csv', contentType: 'text/csv', dataBase64: 'YQ==' }).success).toBe(false);
    expect(LeadImportUploadBody.parse({ requestKey: 'import-key-0001', fileName: 'a.csv', contentType: 'text/csv', dataBase64: 'YQ==' })).toMatchObject({ fileName: 'a.csv' });
    expect(LeadImportConfirmBody.safeParse({ mapping: { name: 0 }, dataSource: 'BOUGHT' }).success).toBe(false);
    expect(LeadImportConfirmBody.parse({ mapping: { name: 0, phone: 1 }, dataSource: 'OWN_CUSTOMERS' })).toMatchObject({ dataSource: 'OWN_CUSTOMERS' });
  });
});

describe('columnLabel', () => {
  it('names a column by its letter and header', () => {
    expect(columnLabel(0, 'Phone')).toBe('A: Phone');
    expect(columnLabel(27, '')).toBe('AB');
  });
});

describe('parseConsentDate', () => {
  const IST = 'Asia/Kolkata';
  it('reads ISO dates and day-first dates as midnight in the workspace zone', () => {
    expect(parseConsentDate('2026-09-14', IST)?.toISOString()).toBe('2026-09-13T18:30:00.000Z');
    expect(parseConsentDate('14/09/2026', IST)?.toISOString()).toBe('2026-09-13T18:30:00.000Z');
    expect(parseConsentDate('14-09-2026', IST)?.toISOString()).toBe('2026-09-13T18:30:00.000Z');
    expect(parseConsentDate('14.09.2026 10:30', IST)?.toISOString()).toBe('2026-09-14T05:00:00.000Z');
    expect(parseConsentDate('2026-09-14T10:30:00Z', IST)?.toISOString()).toBe('2026-09-14T10:30:00.000Z');
    expect(parseConsentDate('2026-09-14 10:30', 'UTC')?.toISOString()).toBe('2026-09-14T10:30:00.000Z');
    expect(parseConsentDate('2026-09-14T10:30', IST)?.toISOString()).toBe('2026-09-14T05:00:00.000Z');
  });

  it('reads Excel date serials (days since 1899-12-30) as wall time in the zone', () => {
    // 46279 is 2026-09-14.
    expect(parseConsentDate('46279', IST)?.toISOString()).toBe('2026-09-13T18:30:00.000Z');
    expect(parseConsentDate('46279.5', 'UTC')?.toISOString()).toBe('2026-09-14T12:00:00.000Z');
  });

  it('refuses anything that is not a real calendar date', () => {
    for (const value of ['', 'yes', '31/02/2026', '2026-13-01', '14/09/26', '12345', '0', 'tomorrow', '2026-09-14T25:00']) {
      expect(parseConsentDate(value, IST), value).toBeNull();
    }
  });
});

describe('consent rules (ADR-120)', () => {
  it('renders the attestation text verbatim with the business name', () => {
    expect(consentAttestationText('Codecraft Web Studio')).toBe(
      'I confirm that each row marked as consented is a person who, on the date given, agreed to receive WhatsApp messages from Codecraft Web Studio about its products and services after seeing the notice below; that Codecraft Web Studio collected this list itself (it was not bought or scraped); and that I can produce the evidence on request. I understand this import will not re-subscribe anyone who has replied STOP.',
    );
  });

  it('a notice must name the business and WhatsApp (case and spacing folded)', () => {
    expect(noticeProblems('Get offers from Smile Avenue Dental Clinic on WhatsApp. Reply STOP to opt out.', 'Smile Avenue Dental Clinic')).toEqual([]);
    expect(noticeProblems('smile  avenue dental clinic will message you on whatsapp', 'Smile Avenue Dental Clinic')).toEqual([]);
    expect(noticeProblems('We will message you on WhatsApp.', 'Smile Avenue Dental Clinic')).toEqual(['NOTICE_MISSING_BUSINESS']);
    expect(noticeProblems('Smile Avenue Dental Clinic will send you offers.', 'Smile Avenue Dental Clinic')).toEqual(['NOTICE_MISSING_WHATSAPP']);
  });

  it('only own lists are a data source that can carry consent', () => {
    expect(isOwnDataSource('OWN_CUSTOMERS')).toBe(true);
    expect(isOwnDataSource('OWN_FORM_OR_EVENT')).toBe(true);
    expect(isOwnDataSource('PUBLIC_DIRECTORY')).toBe(false);
    expect(isOwnDataSource('THIRD_PARTY_LIST')).toBe(false);
    expect(isOwnDataSource(null)).toBe(false);
  });

  it('the per-row external id carries the import and the row number', () => {
    const id = fileImportExternalId('imp_123', 42);
    expect(id).toBe('import:imp_123:row:42');
    expect(parseFileImportExternalId(id)).toEqual({ importId: 'imp_123', row: 42 });
    expect(parseFileImportExternalId('row-42')).toBeNull();
  });
});
