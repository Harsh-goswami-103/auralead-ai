/**
 * Phone normalization to E.164 (R12, default region IN). Uses libphonenumber-js `max`
 * metadata so validity checks the digits, not just the length. Any Unicode decimal digits used
 * in Indian sources (full-width, Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu,
 * Kannada, Malayalam, Arabic-Indic) are mapped to ASCII first. Invalid input is kept raw, never
 * guessed at.
 */
import { findPhoneNumbersInText, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

export const DEFAULT_PHONE_REGION: CountryCode = 'IN';

/** Code points of the digit zero in each supported script; digits n are zero + n. */
const DIGIT_ZEROS = [0x0660, 0x06f0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0xff10];

export function normalizeDigits(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const zero = DIGIT_ZEROS.find((z) => cp >= z && cp <= z + 9);
    out += zero === undefined ? ch : String.fromCharCode(0x30 + cp - zero);
  }
  return out;
}

export type PhoneParse = {
  /** The input exactly as given. */
  raw: string;
  e164: string | null;
  valid: boolean;
  country: string | null;
};

export function parsePhone(raw: string, defaultRegion: CountryCode = DEFAULT_PHONE_REGION): PhoneParse {
  const invalid: PhoneParse = { raw, e164: null, valid: false, country: null };
  const text = normalizeDigits(raw).trim();
  if (text === '') return invalid;
  const parsed = parsePhoneNumberFromString(text, defaultRegion);
  if (!parsed || !parsed.isValid()) return invalid;
  return { raw, e164: parsed.number, valid: true, country: parsed.country ?? null };
}

export type PhoneList = {
  /** First valid number in input order. */
  primary: string | null;
  /** Further distinct valid numbers, in input order (Lead.alternatePhones). */
  alternates: string[];
  /** Trimmed pieces that held no valid number, kept raw. */
  invalid: string[];
};

/** Separators between numbers in one field: , ; | newlines, a slash between numbers, "or", "&". */
const SPLIT = /[,;|\r\n]+|\s+\/\s*|\s*\/\s+|(?<=\d)\/(?=[\d+])|\s+(?:or|and|&)\s+/i;

/** Splits a field that may hold several numbers ("98100 12345 / 011-2345 6789"). */
export function parsePhones(raw: string, defaultRegion: CountryCode = DEFAULT_PHONE_REGION): PhoneList {
  const found: string[] = [];
  const invalid: string[] = [];
  for (const piece of raw.split(SPLIT)) {
    const chunk = piece.trim();
    if (chunk === '') continue;
    const single = parsePhone(chunk, defaultRegion);
    if (single.e164) {
      found.push(single.e164);
      continue;
    }
    const inText = findPhoneNumbersInText(normalizeDigits(chunk), { defaultCountry: defaultRegion })
      .filter((m) => m.number.isValid())
      .map((m) => m.number.number);
    if (inText.length > 0) found.push(...inText);
    else invalid.push(chunk);
  }
  const distinct = [...new Set(found)];
  return { primary: distinct[0] ?? null, alternates: distinct.slice(1), invalid };
}
