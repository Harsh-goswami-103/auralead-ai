/**
 * The DEMO Places directory (ADR-118, slice F1): a deterministic, fictitious stand-in for Google
 * Places Text Search that echoes the keyword and location the person typed. Every value is a pure
 * function of the query and the result's position, so the same search always shows the same
 * businesses (and a replayed import dedupes), while another keyword or city gives other ones.
 *
 * - The category follows the keyword (restaurant, dental clinic, salon, gym, boutique, coaching
 *   centre, ...; an unknown keyword becomes its own category).
 * - The city follows the location: Indore and Bhopal have their own localities and PIN codes,
 *   other well-known cities their state and PIN prefix, anything else a generic locality.
 * - Phones are valid Indian mobile numbers in the existing demo style (`demoMobile`); about one in
 *   eight listings has none. About half the listings have no website (`websiteListed: false`),
 *   which is the lead a web-development client wants. Websites and the emails a DEMO extraction
 *   "finds" use the `demo-leads.in` domain.
 * - Place IDs look like `ChIJdemo-<query hash>-<index>`, so a DEMO Refresh can rebuild a listing
 *   from its ID and the stored keyword and location.
 *
 * DEMO makes zero outbound calls: nothing here is ever contacted, and every row built from it is
 * flagged simulated. Framework-free and pure.
 */
import { demoMobile, pick, seedHash } from './contacts';

export type DemoPlaceQuery = { keyword: string; location: string };

export type DemoPlace = {
  placeId: string;
  name: string;
  category: string;
  /** Display form `+91 98xxx xxxxx`, or null for a listing without a phone. */
  phone: string | null;
  website: string | null;
  /** False when the listing has no website (ADR-119). */
  websiteListed: boolean;
  /** Stars with one decimal (3.2 to 4.9), or null for a listing nobody rated yet. */
  rating: number | null;
  reviewCount: number | null;
  address: string;
  city: string;
  state: string | null;
  pincode: string;
};

export type DemoWebsiteEmail = { address: string; sourceUrl: string; kind: 'ROLE' | 'PERSONAL' | 'FREEMAIL' };

/** Results per page, as Text Search returns them. */
export const DEMO_PLACES_PAGE_SIZE = 20;
/** Text Search returns at most three pages of 20 per query. */
export const DEMO_PLACES_MAX_PAGES = 3;
export const DEMO_PLACES_DOMAIN = 'demo-leads.in';

const PLACE_ID_RE = /^ChIJdemo-([0-9a-z]+)-(\d{1,3})$/;

type Kind = { test: RegExp; category: string; words: readonly string[] };

const KINDS: readonly Kind[] = [
  { test: /dental|dentist|teeth|orthodont/, category: 'Dental clinic', words: ['Dental Care', 'Smile Dental Clinic', 'Tooth Studio', 'Dental Hospital'] },
  { test: /restaurant|dhaba|biryani|thali|eatery|food|kitchen|veg/, category: 'Restaurant', words: ['Restaurant', 'Kitchen', 'Dhaba', 'Bhojanalaya', 'Family Restaurant'] },
  { test: /cafe|coffee|tea/, category: 'Cafe', words: ['Cafe', 'Coffee House', 'Chai Point', 'Brew Bar'] },
  { test: /bakery|cake|sweet|mithai|namkeen/, category: 'Bakery', words: ['Bakers', 'Cake Shop', 'Sweets', 'Bakery'] },
  { test: /salon|parlour|parlor|beauty|spa|hair|makeup/, category: 'Beauty salon', words: ['Salon', 'Beauty Parlour', 'Hair Studio', 'Unisex Salon'] },
  { test: /gym|fitness|yoga|crossfit/, category: 'Gym', words: ['Fitness', 'Gym', 'Fitness Studio', 'Health Club'] },
  { test: /boutique|cloth|garment|saree|fashion|tailor|apparel/, category: 'Clothing boutique', words: ['Boutique', 'Fashion House', 'Collection', 'Designer Studio'] },
  { test: /coaching|tuition|classes|academy|institute|tutor/, category: 'Coaching centre', words: ['Classes', 'Academy', 'Coaching Centre', 'Institute'] },
  { test: /clinic|doctor|hospital|physio|skin|derma|diagnostic|pathology/, category: 'Medical clinic', words: ['Clinic', 'Health Care', 'Medical Centre', 'Diagnostics'] },
  { test: /pharmacy|chemist|medical store/, category: 'Pharmacy', words: ['Medicals', 'Pharmacy', 'Chemists'] },
  { test: /hotel|lodge|guest ?house|homestay|resort/, category: 'Hotel', words: ['Hotel', 'Residency', 'Guest House', 'Inn'] },
  { test: /real ?estate|property|builder|broker/, category: 'Real estate agency', words: ['Properties', 'Realty', 'Estate Consultants'] },
  { test: /interior|furniture|decor|modular/, category: 'Interior designer', words: ['Interiors', 'Design Studio', 'Furnishers'] },
  { test: /travel|tour|holiday/, category: 'Travel agency', words: ['Tours & Travels', 'Holidays', 'Travels'] },
  { test: /car|auto|garage|mechanic|bike|motor/, category: 'Car repair', words: ['Auto Care', 'Motors', 'Car Care', 'Garage'] },
  { test: /photo|wedding|studio|video/, category: 'Photographer', words: ['Studio', 'Photography', 'Clicks', 'Films'] },
  { test: /\bca\b|chartered|accountant|tax|gst/, category: 'Chartered accountant', words: ['& Associates', 'Tax Consultants', 'Accounts & Co'] },
];

const PREFIXES = ['Shree', 'Royal', 'Urban', 'Sunrise', 'Lotus', 'Prime', 'Golden', 'Nova', 'Kesar', 'Sai', 'New', 'Classic', 'Star', 'Om', 'Maa', 'Apna', 'Mahalaxmi', 'Krishna', 'Shiv', 'Green Leaf'] as const;

type CityInfo = { city: string; state: string; localities: ReadonlyArray<readonly [string, string]> };

const INDORE: CityInfo = {
  city: 'Indore',
  state: 'Madhya Pradesh',
  localities: [
    ['Vijay Nagar', '452010'],
    ['Palasia', '452001'],
    ['Rajwada', '452004'],
    ['Bhawarkuan', '452001'],
    ['Sapna Sangeeta Road', '452001'],
    ['Nipania', '452010'],
    ['Scheme No. 54', '452010'],
    ['AB Road', '452008'],
    ['Annapurna Road', '452009'],
    ['Sudama Nagar', '452009'],
    ['Khajrana', '452016'],
    ['Bengali Square', '452016'],
    ['Malharganj', '452002'],
    ['Sukhliya', '452010'],
    ['Rau', '453331'],
  ],
};

const BHOPAL: CityInfo = {
  city: 'Bhopal',
  state: 'Madhya Pradesh',
  localities: [
    ['MP Nagar', '462011'],
    ['Arera Colony', '462016'],
    ['New Market', '462003'],
    ['Kolar Road', '462042'],
    ['Shahpura', '462039'],
    ['Bairagarh', '462030'],
    ['Habibganj', '462024'],
    ['TT Nagar', '462003'],
    ['Ayodhya Bypass', '462041'],
    ['Indrapuri', '462022'],
    ['Karond', '462038'],
    ['Hoshangabad Road', '462026'],
  ],
};

/** Other well-known cities: state and the first three digits of their PIN codes. */
const KNOWN_CITIES: ReadonlyArray<{ test: RegExp; city: string; state: string; pin: string }> = [
  { test: /mumbai|bombay/, city: 'Mumbai', state: 'Maharashtra', pin: '400' },
  { test: /pune/, city: 'Pune', state: 'Maharashtra', pin: '411' },
  { test: /nagpur/, city: 'Nagpur', state: 'Maharashtra', pin: '440' },
  { test: /new delhi|delhi/, city: 'New Delhi', state: 'Delhi', pin: '110' },
  { test: /gurugram|gurgaon/, city: 'Gurugram', state: 'Haryana', pin: '122' },
  { test: /noida/, city: 'Noida', state: 'Uttar Pradesh', pin: '201' },
  { test: /lucknow/, city: 'Lucknow', state: 'Uttar Pradesh', pin: '226' },
  { test: /bengaluru|bangalore/, city: 'Bengaluru', state: 'Karnataka', pin: '560' },
  { test: /hyderabad/, city: 'Hyderabad', state: 'Telangana', pin: '500' },
  { test: /chennai|madras/, city: 'Chennai', state: 'Tamil Nadu', pin: '600' },
  { test: /kolkata|calcutta/, city: 'Kolkata', state: 'West Bengal', pin: '700' },
  { test: /ahmedabad/, city: 'Ahmedabad', state: 'Gujarat', pin: '380' },
  { test: /surat/, city: 'Surat', state: 'Gujarat', pin: '395' },
  { test: /jaipur/, city: 'Jaipur', state: 'Rajasthan', pin: '302' },
  { test: /ujjain/, city: 'Ujjain', state: 'Madhya Pradesh', pin: '456' },
  { test: /jabalpur/, city: 'Jabalpur', state: 'Madhya Pradesh', pin: '482' },
  { test: /gwalior/, city: 'Gwalior', state: 'Madhya Pradesh', pin: '474' },
];

const GENERIC_LOCALITIES = ['MG Road', 'Station Road', 'Civil Lines', 'Gandhi Nagar', 'Nehru Nagar', 'Main Market', 'Sadar Bazar', 'Shastri Nagar', 'Model Town', 'Ram Nagar'] as const;

const FIRST_NAMES = ['rahul', 'priya', 'amit', 'neha', 'vikas', 'sneha', 'arjun', 'kavita', 'rohit', 'anjali'] as const;

/** Lower case, single spaces: the form the seeds are built from (so "Indore " and "indore" agree). */
export function normalizeDemoQueryPart(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function titleCase(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

function queryKey(query: DemoPlaceQuery): string {
  return `${normalizeDemoQueryPart(query.keyword)}|${normalizeDemoQueryPart(query.location)}`;
}

function queryHash(query: DemoPlaceQuery): string {
  return seedHash(`places:${queryKey(query)}`).toString(36);
}

/** The seed of the result at `index` (0-based, across pages) for a query. */
export function demoPlaceSeed(query: DemoPlaceQuery, index: number): string {
  return `${queryKey(query)}|${index}`;
}

function kindOf(keyword: string): Kind {
  const k = normalizeDemoQueryPart(keyword);
  const known = KINDS.find((kind) => kind.test.test(k));
  if (known) return known;
  const label = titleCase(keyword) || 'Business';
  return { test: /$^/, category: label, words: [label, `${label} Services`, `${label} Centre`] };
}

type Place = { city: string; state: string | null; locality: string; pincode: string };

function placeOf(seed: string, location: string): Place {
  const loc = normalizeDemoQueryPart(location);
  const known = /indore/.test(loc) ? INDORE : /bhopal/.test(loc) ? BHOPAL : null;
  if (known) {
    const [locality, pincode] = pick(`${seed}:locality`, known.localities);
    return { city: known.city, state: known.state, locality, pincode };
  }
  const locality = pick(`${seed}:locality`, GENERIC_LOCALITIES);
  const city = KNOWN_CITIES.find((c) => c.test.test(loc));
  if (city) return { city: city.city, state: city.state, locality, pincode: `${city.pin}${String(1 + (seedHash(`${seed}:pin`) % 60)).padStart(3, '0')}` };
  // An unknown place: the first part of what was typed, a plausible six-digit PIN (first digit 1-8).
  const name = titleCase(location.split(',')[0] ?? location) || 'Your City';
  const first = 1 + (seedHash(`places-city:${loc}`) % 8);
  const rest = String(seedHash(`places-city-pin:${loc}`) % 100_000).padStart(5, '0');
  return { city: name, state: null, locality, pincode: `${first}${rest}` };
}

function slugOf(name: string, seed: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}${seedHash(`${seed}:slug`) % 100}`;
}

/** One simulated listing for `seed` (see `demoPlaceSeed`), echoing the query's keyword and location. */
export function demoPlace(seed: string, query: DemoPlaceQuery): DemoPlace {
  const kind = kindOf(query.keyword);
  const prefix = pick(`${seed}:prefix`, PREFIXES);
  const word = pick(`${seed}:word`, kind.words);
  const name = `${prefix} ${word}`;
  const place = placeOf(seed, query.location);
  const index = Number(seed.slice(seed.lastIndexOf('|') + 1));
  const placeId = `ChIJdemo-${queryHash(query)}-${Number.isInteger(index) && index >= 0 ? index : seedHash(seed) % 1000}`;
  const hasWebsite = seedHash(`${seed}:web`) % 2 === 1;
  const hasPhone = seedHash(`${seed}:hasphone`) % 8 !== 0;
  const rated = seedHash(`${seed}:rated`) % 10 !== 0;
  const shopNo = 1 + (seedHash(`${seed}:no`) % 240);
  const address = `${shopNo}, ${place.locality}, ${place.city}, ${place.state ? `${place.state} ` : ''}${place.pincode}, India`;
  return {
    placeId,
    name,
    category: kind.category,
    phone: hasPhone ? demoMobile(`${seed}:phone`) : null,
    website: hasWebsite ? `https://${slugOf(name, seed)}.${DEMO_PLACES_DOMAIN}` : null,
    websiteListed: hasWebsite,
    rating: rated ? (32 + (seedHash(`${seed}:rating`) % 18)) / 10 : null,
    reviewCount: rated ? 3 + (seedHash(`${seed}:reviews`) % 1200) : null,
    address,
    city: place.city,
    state: place.state,
    pincode: place.pincode,
  };
}

/** How many listings the simulated directory holds for a query (24 to 60). */
export function demoPlacesTotal(query: DemoPlaceQuery): number {
  return 24 + (seedHash(`places-total:${queryKey(query)}`) % 37);
}

/** One page (0-based) of a query, at most 20 listings, and whether a next page exists. */
export function demoPlacesPage(query: DemoPlaceQuery, pageIndex: number): { places: DemoPlace[]; hasNextPage: boolean } {
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= DEMO_PLACES_MAX_PAGES) return { places: [], hasNextPage: false };
  const total = demoPlacesTotal(query);
  const start = pageIndex * DEMO_PLACES_PAGE_SIZE;
  const end = Math.min(total, start + DEMO_PLACES_PAGE_SIZE);
  const places: DemoPlace[] = [];
  for (let i = start; i < end; i += 1) places.push(demoPlace(demoPlaceSeed(query, i), query));
  return { places, hasNextPage: end < total && pageIndex + 1 < DEMO_PLACES_MAX_PAGES };
}

/** The listing a simulated place ID stands for, given the keyword and location it was found with; null when it is not one. */
export function demoPlaceById(placeId: string, query: DemoPlaceQuery): DemoPlace | null {
  const m = PLACE_ID_RE.exec(placeId);
  if (!m || m[1] !== queryHash(query)) return null;
  const index = Number(m[2]);
  if (index >= demoPlacesTotal(query)) return null;
  return demoPlace(demoPlaceSeed(query, index), query);
}

/**
 * The addresses a DEMO email extraction "finds" on a simulated listing's website (`@demo-leads.in`):
 * none without a website, otherwise a role address on most sites and sometimes a named one.
 */
export function demoWebsiteEmails(place: Pick<DemoPlace, 'placeId' | 'website' | 'name'>): DemoWebsiteEmail[] {
  if (!place.website) return [];
  const h = seedHash(`emails:${place.placeId}`);
  if (h % 5 === 0) return [];
  const slug = place.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const out: DemoWebsiteEmail[] = [{ address: `hello.${slug}@${DEMO_PLACES_DOMAIN}`, sourceUrl: `${place.website}/contact`, kind: 'ROLE' }];
  if (h % 3 === 0) out.push({ address: `${pick(`emails-name:${place.placeId}`, FIRST_NAMES)}.${slug}@${DEMO_PLACES_DOMAIN}`, sourceUrl: `${place.website}/about`, kind: 'PERSONAL' });
  return out;
}
