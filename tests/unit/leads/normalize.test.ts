// R12, R13: lead normalization is pure and conservative. It maps the source fields onto the Lead
// columns, converts phones to E.164 (IN default) keeping alternates and the raw text, never
// invents or guesses an email, nulls placeholder emails, keeps the website status UNKNOWN unless a
// website was supplied (then PRESENT_UNVERIFIED; only enrichment or a human may go further) or the
// source says the listing has none (NOT_LISTED, ADR-119), keeps only valid PIN codes, and rejects a
// record per row with a reason code instead of failing the batch.
import { describe, expect, it } from 'vitest';
import {
  isPlaceholderEmail,
  normalizeEmail,
  normalizeLeadFields,
  normalizeName,
  normalizePincode,
  normalizeWebsite,
  parseRatingX10,
  parseReviewCount,
} from '@/server/services/leads/normalize';

describe('normalizeLeadFields', () => {
  it('maps a Google Maps style record onto the lead columns', () => {
    const result = normalizeLeadFields({
      name: '  Smile   Care  Dental Clinic ',
      phone: '098100 12345 / 0124-4001234',
      email: null,
      website: 'smilecare.in',
      address: 'Sector 29, Gurugram',
      city: 'Gurugram',
      category: 'Dental clinic',
      rating: '4.6',
      reviewCount: '(1,234)',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lead).toMatchObject({
      displayName: 'Smile Care Dental Clinic',
      nameNormalized: 'smile care dental clinic',
      phoneE164: '+919810012345',
      phoneRaw: '098100 12345 / 0124-4001234',
      alternatePhones: ['+911244001234'],
      emailNormalized: null,
      website: 'https://smilecare.in/',
      websiteStatus: 'PRESENT_UNVERIFIED',
      address: 'Sector 29, Gurugram',
      city: 'Gurugram',
      category: 'Dental clinic',
      rating: 46,
      reviewCount: 1234,
    });
  });

  it('never invents an email from the website, name or phone', () => {
    const result = normalizeLeadFields({ name: 'Iron Gym', phone: '+91 98200 11111', website: 'https://irongym.in' });
    expect(result.ok && result.lead.emailNormalized).toBeNull();
  });

  it('website status is UNKNOWN by default and never VERIFIED_ABSENT at ingestion', () => {
    const none = normalizeLeadFields({ name: 'No Site Realty', phone: '9876543210' });
    expect(none.ok && none.lead.websiteStatus).toBe('UNKNOWN');
    expect(none.ok && none.lead.website).toBeNull();
    const garbage = normalizeLeadFields({ name: 'Bad Site', phone: '9876543210', website: 'javascript:alert(1)' });
    expect(garbage.ok && garbage.lead.websiteStatus).toBe('UNKNOWN');
    expect(garbage.ok && garbage.lead.website).toBeNull();
  });

  it('nulls placeholder emails and keeps real ones lowercased', () => {
    for (const placeholder of ['na@na.com', 'noemail@gmail.com', 'test@test.com', 'none@example.com', 'abc@xyz.test', 'no-reply@foo.in']) {
      const r = normalizeLeadFields({ name: 'Kesari', phone: '9876543210', email: placeholder });
      expect(r.ok && r.lead.emailNormalized, placeholder).toBeNull();
    }
    const real = normalizeLeadFields({ name: 'Kesari', email: '  Orders@KesariCrafts.IN ' });
    expect(real.ok && real.lead.emailNormalized).toBe('orders@kesaricrafts.in');
  });

  it('rejects a record without a name', () => {
    expect(normalizeLeadFields({ name: '   ', phone: '9876543210' })).toEqual({ ok: false, reasonCode: 'MISSING_NAME' });
  });

  it('rejects a record without any valid phone or email, keeping invalid phones out of the lead', () => {
    expect(normalizeLeadFields({ name: 'Ghost Studio', phone: '12345', email: 'not-an-email' })).toEqual({ ok: false, reasonCode: 'NO_VALID_CONTACT' });
    expect(normalizeLeadFields({ name: 'Ghost Studio', email: 'n/a' })).toEqual({ ok: false, reasonCode: 'NO_VALID_CONTACT' });
  });

  it('keeps a lead with an email but an invalid phone, with the raw phone preserved', () => {
    const r = normalizeLeadFields({ name: 'Pixel Chai', phone: '000', email: 'hello@pixelchai.in' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lead).toMatchObject({ phoneE164: null, phoneRaw: '000', alternatePhones: [], emailNormalized: 'hello@pixelchai.in' });
  });

  it('NOT_LISTED only when the source says the listing has no website and no URL came with it (ADR-119)', () => {
    const notListed = normalizeLeadFields({ name: 'Annapurna Sweets', phone: '9826012345', websiteListed: false });
    expect(notListed.ok && notListed.lead).toMatchObject({ website: null, websiteStatus: 'NOT_LISTED' });
    // A blank website value is no website.
    const blank = normalizeLeadFields({ name: 'Annapurna Sweets', phone: '9826012345', website: '   ', websiteListed: false });
    expect(blank.ok && blank.lead.websiteStatus).toBe('NOT_LISTED');
    // The listing gave a URL after all: the URL wins.
    const listedAnyway = normalizeLeadFields({ name: 'Annapurna Sweets', phone: '9826012345', website: 'annapurna.in', websiteListed: false });
    expect(listedAnyway.ok && listedAnyway.lead).toMatchObject({ website: 'https://annapurna.in/', websiteStatus: 'PRESENT_UNVERIFIED' });
    // A value that is not a usable URL is not evidence of "no website": UNKNOWN, never NOT_LISTED.
    const garbage = normalizeLeadFields({ name: 'Annapurna Sweets', phone: '9826012345', website: 'javascript:alert(1)', websiteListed: false });
    expect(garbage.ok && garbage.lead).toMatchObject({ website: null, websiteStatus: 'UNKNOWN' });
    // Without the source's statement, a missing website stays UNKNOWN.
    for (const websiteListed of [true, null, undefined]) {
      const r = normalizeLeadFields({ name: 'Annapurna Sweets', phone: '9826012345', websiteListed });
      expect(r.ok && r.lead.websiteStatus, String(websiteListed)).toBe('UNKNOWN');
    }
  });

  it('keeps a valid Indian PIN code and drops anything else', () => {
    const r = normalizeLeadFields({ name: 'Codecraft Web Studio', phone: '9826012345', pincode: '452 001' });
    expect(r.ok && r.lead.pincode).toBe('452001');
    const bad = normalizeLeadFields({ name: 'Codecraft Web Studio', phone: '9826012345', pincode: '45200' });
    expect(bad.ok && bad.lead.pincode).toBeNull();
    const none = normalizeLeadFields({ name: 'Codecraft Web Studio', phone: '9826012345' });
    expect(none.ok && none.lead.pincode).toBeNull();
  });

  it('accepts full-width and Devanagari digits', () => {
    const r = normalizeLeadFields({ name: 'Nestkey', phone: '９８４５０ １２３４５' });
    expect(r.ok && r.lead.phoneE164).toBe('+919845012345');
    const d = normalizeLeadFields({ name: 'Nestkey', phone: '९८४५०१२३४५' });
    expect(d.ok && d.lead.phoneE164).toBe('+919845012345');
  });
});

describe('field helpers', () => {
  it('normalizeName folds case, accents, punctuation and whitespace', () => {
    expect(normalizeName('Café  Délice & Co.')).toBe('cafe delice co');
    expect(normalizeName('ＡＢＣ Fitness')).toBe('abc fitness');
  });

  it('normalizeEmail strips mailto and rejects malformed addresses', () => {
    expect(normalizeEmail('mailto:Hi@Example.in')).toBe('hi@example.in');
    expect(normalizeEmail('two@@signs.in')).toBeNull();
    expect(normalizeEmail('no-domain@')).toBeNull();
    expect(normalizeEmail('')).toBeNull();
  });

  it('isPlaceholderEmail recognises common filler values', () => {
    expect(isPlaceholderEmail('na@na.com')).toBe(true);
    expect(isPlaceholderEmail('owner@example.org')).toBe(true);
    expect(isPlaceholderEmail('rohan@ironpulse.in')).toBe(false);
  });

  it('normalizeWebsite allows only public-looking http(s) URLs without credentials', () => {
    expect(normalizeWebsite('www.nestkey.in/about')).toBe('https://www.nestkey.in/about');
    expect(normalizeWebsite('http://nestkey.in')).toBe('http://nestkey.in/');
    expect(normalizeWebsite('ftp://nestkey.in')).toBeNull();
    expect(normalizeWebsite('https://user:pw@nestkey.in')).toBeNull();
    expect(normalizeWebsite('localhost')).toBeNull();
    expect(normalizeWebsite('  ')).toBeNull();
  });

  it('normalizePincode accepts six-digit PIN codes in any digit script and never guesses', () => {
    expect(normalizePincode('452001')).toBe('452001');
    expect(normalizePincode(452001)).toBe('452001');
    expect(normalizePincode(' 452-001 ')).toBe('452001');
    expect(normalizePincode('४५२००१')).toBe('452001');
    expect(normalizePincode('０５２００１')).toBeNull();
    expect(normalizePincode('45200')).toBeNull();
    expect(normalizePincode('4520011')).toBeNull();
    expect(normalizePincode('Indore 452001')).toBeNull();
    expect(normalizePincode(4.52)).toBeNull();
    expect(normalizePincode('')).toBeNull();
    expect(normalizePincode(null)).toBeNull();
    expect(normalizePincode(undefined)).toBeNull();
  });

  it('parseRatingX10 and parseReviewCount accept common spellings and reject out-of-range values', () => {
    expect(parseRatingX10(4.55)).toBe(46);
    expect(parseRatingX10('4,2')).toBe(42);
    expect(parseRatingX10('5.1')).toBeNull();
    expect(parseRatingX10('n/a')).toBeNull();
    expect(parseReviewCount('2,345 reviews')).toBe(2345);
    expect(parseReviewCount(-3)).toBeNull();
    expect(parseReviewCount(null)).toBeNull();
  });
});
