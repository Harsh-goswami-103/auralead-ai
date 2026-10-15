import { describe, expect, it } from 'vitest';
import { normalizeDigits, parsePhone, parsePhones } from '@/lib/phone';

describe('normalizeDigits', () => {
  it('converts full-width and Indic digits to ASCII and leaves the rest alone', () => {
    expect(normalizeDigits('９８１００ １２３４５')).toBe('98100 12345');
    expect(normalizeDigits('९८१००१२३४५')).toBe('9810012345'); // Devanagari
    expect(normalizeDigits('৯৮১০০১২৩৪৫')).toBe('9810012345'); // Bengali
    expect(normalizeDigits('٩٨١٠٠١٢٣٤٥')).toBe('9810012345'); // Arabic-Indic
    expect(normalizeDigits('+91-(98100)')).toBe('+91-(98100)');
  });
});

describe('parsePhone (E.164, default region IN)', () => {
  it.each([
    ['98100 12345', '+919810012345'],
    ['09810012345', '+919810012345'],
    ['+91 98100 12345', '+919810012345'],
    ['919810012345', '+919810012345'],
    ['011-2345 6789', '+911123456789'],
    ['９８１００ １２３４５', '+919810012345'],
    ['९८१०० १२३४५', '+919810012345'],
    ['+44 20 7946 0958', '+442079460958'],
  ])('%s -> %s', (raw, e164) => {
    const p = parsePhone(raw);
    expect(p).toMatchObject({ raw, e164, valid: true });
  });

  it('reports the country of a valid number', () => {
    expect(parsePhone('98100 12345').country).toBe('IN');
    expect(parsePhone('+44 20 7946 0958').country).toBe('GB');
  });

  it.each(['12345', 'abc', '', '   ', '+91 00000'])('keeps invalid input %j raw with no E.164', (raw) => {
    expect(parsePhone(raw)).toEqual({ raw, e164: null, valid: false, country: null });
  });

  it('honours an explicit default region', () => {
    expect(parsePhone('(213) 373-4253', 'US').e164).toBe('+12133734253');
  });
});

describe('parsePhones (multi-number split)', () => {
  it('splits on common separators and keeps order', () => {
    const r = parsePhones('98100 12345 / 011-2345 6789, +91 99999 88888');
    expect(r.primary).toBe('+919810012345');
    expect(r.alternates).toEqual(['+911123456789', '+919999988888']);
    expect(r.invalid).toEqual([]);
  });

  it('finds several numbers in one chunk separated by spaces or words', () => {
    expect(parsePhones('9810012345 9811112345').primary).toBe('+919810012345');
    expect(parsePhones('9810012345 9811112345').alternates).toEqual(['+919811112345']);
    expect(parsePhones('Call 98100 12345 or 011 2345 6789').alternates).toEqual(['+911123456789']);
  });

  it('dedupes the same number written differently', () => {
    const r = parsePhones('098100 12345; +91 98100 12345\n９８１００１２３４５');
    expect(r.primary).toBe('+919810012345');
    expect(r.alternates).toEqual([]);
  });

  it('keeps invalid pieces raw (trimmed) and still returns the valid ones', () => {
    const r = parsePhones('12345 | 98100 12345 | n/a');
    expect(r.primary).toBe('+919810012345');
    expect(r.invalid).toEqual(['12345', 'n/a']);
  });

  it('returns nothing valid for empty or junk input, keeping the junk raw', () => {
    expect(parsePhones('')).toEqual({ primary: null, alternates: [], invalid: [] });
    expect(parsePhones('call me')).toEqual({ primary: null, alternates: [], invalid: ['call me'] });
  });
});
