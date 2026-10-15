// R12, R13: lead normalization is pure and conservative. It maps the source fields onto the Lead
// columns, converts phones to E.164 (IN default) keeping alternates and the raw text, never
// invents or guesses an email, nulls placeholder emails, keeps the website status UNKNOWN unless a
// website was supplied (then PRESENT_UNVERIFIED; only enrichment or a human may go further), and
// rejects a record per row with a reason code instead of failing the batch.
import { describe, expect, it } from 'vitest';
import {
  isPlaceholderEmail,
  normalizeEmail,
  normalizeLeadFields,
  normalizeName,
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
