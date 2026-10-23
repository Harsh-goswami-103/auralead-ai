// ADR-118 (slice F1): the Google Places API (New) adapter against a scripted transport and the
// documented-shape fixtures (tests/fixtures/places/documented-shape, `verified: false`, never
// recorded traffic). It pins the request (URL, method, X-Goog-Api-Key, the exact field mask with
// no reviews or photos, the Text Search body with languageCode en and regionCode IN, the page token
// on a next page), the parsing (city, state and PIN code from addressComponents, "no website" when
// websiteUri is absent, attributions), the error classification (400 API_KEY_INVALID, 400
// INVALID_ARGUMENT, 403 PERMISSION_DENIED, 404, 429 with Retry-After, 503, a thrown request) and
// that the API key never appears in any text the adapter returns. DEMO refuses every host.
import { describe, expect, it } from 'vitest';
import { FixedClock } from '@/lib/clock';
import { outboundAttempts, resetOutboundAttempts } from '@/server/adapters/http/outbound';
import { addressParts, createGooglePlacesClient, PLACES_CHECK_FIELD_MASK, PLACES_CHECKED_ON } from '@/server/adapters/places/google-places';
import { PLACES_DETAILS_FIELD_MASK, PLACES_SEARCH_FIELD_MASK, placesMapsLink } from '@/server/adapters/places/port';
import { DETAILS_PATH, FakeGraph, networkError, PLACES_KEY, placesAnswer, placesFixture, placesSources, SEARCH_PATH } from './places-support';

const clock = new FixedClock('2026-10-23T06:00:00.000Z');

function client(graph: FakeGraph) {
  return createGooglePlacesClient({ mode: 'live', apiKey: PLACES_KEY, clock, http: graph.http });
}

describe('field mask (ADR-118)', () => {
  it('is exactly the documented place fields plus nextPageToken; never reviews, photos or coordinates', () => {
    expect(PLACES_SEARCH_FIELD_MASK).toBe(
      'places.id,places.displayName,places.primaryTypeDisplayName,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.formattedAddress,places.addressComponents,places.googleMapsUri,places.attributions,nextPageToken',
    );
    expect(PLACES_DETAILS_FIELD_MASK).toBe('id,displayName,primaryTypeDisplayName,nationalPhoneNumber,internationalPhoneNumber,websiteUri,rating,userRatingCount,formattedAddress,addressComponents,googleMapsUri,attributions');
    for (const mask of [PLACES_SEARCH_FIELD_MASK, PLACES_DETAILS_FIELD_MASK, PLACES_CHECK_FIELD_MASK]) {
      expect(mask).not.toMatch(/review|photo|location|viewport|\*/i);
    }
  });

  it('every fixture is documented shape, unverified, with the checked-on date of the adapter', () => {
    const sources = placesSources();
    expect(PLACES_CHECKED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sources.checked).toBe(PLACES_CHECKED_ON);
    for (const [name, meta] of Object.entries(sources.files)) {
      expect(meta.verified, name).toBe(false);
      expect(meta.kind, name).toBe('documented-shape, not recorded live traffic');
      expect(meta.checked.startsWith(PLACES_CHECKED_ON), name).toBe(true);
      expect(() => placesFixture(name), name).not.toThrow();
    }
  });
});

describe('Text Search', () => {
  it('POSTs the documented request and parses a page with its next page token', async () => {
    const graph = new FakeGraph().on('POST', SEARCH_PATH, placesAnswer('response.search-page-1.json'));
    const r = await client(graph).searchText({ keyword: 'dental clinic', location: 'Indore', pageSize: 20 });
    expect(graph.unexpected).toEqual([]);
    const req = graph.requests[0]!;
    expect(req.url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(req.method).toBe('POST');
    expect(req.headers['x-goog-api-key']).toBe(PLACES_KEY);
    expect(req.headers['x-goog-fieldmask']).toBe(PLACES_SEARCH_FIELD_MASK);
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.body).toEqual({ textQuery: 'dental clinic in Indore', pageSize: 20, languageCode: 'en', regionCode: 'IN' });
    expect(req.query).toEqual({});

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.nextPageToken).toBe('AeCrKXsFixtureNextPageToken_page2');
    expect(r.data.places).toHaveLength(3);
    expect(r.data.places[0]).toEqual({
      placeId: 'ChIJF1nderFixtureSmileDental01',
      name: 'Fixture Smile Dental Care',
      category: 'Dental Clinic',
      phone: '+91 98260 10001',
      website: 'https://smile-dental.example.in/',
      websiteListed: true,
      rating: 4.6,
      reviewCount: 212,
      address: '12, Vijay Nagar, Indore, Madhya Pradesh 452010, India',
      city: 'Indore',
      state: 'Madhya Pradesh',
      pincode: '452010',
      attributions: [],
    });
    // No websiteUri although it was requested: the listing has no website (ADR-119).
    expect(r.data.places[1]).toMatchObject({ placeId: 'ChIJF1nderFixtureRoyalDental02', website: null, websiteListed: false, pincode: '452001', attributions: [{ provider: 'Fixture Listings Partner', providerUri: 'https://partner.example.com/' }] });
    // A sparse listing keeps nulls instead of guesses.
    expect(r.data.places[2]).toMatchObject({ phone: null, rating: null, reviewCount: null, category: null, pincode: null, city: 'Indore' });
    // googleMapsUri is requested (ADR-118) but never part of what is stored.
    expect(Object.keys(r.data.places[0]!)).not.toContain('googleMapsUri');
  });

  it('sends the page token with the same query for a next page, and a last page has no token', async () => {
    const graph = new FakeGraph().on('POST', SEARCH_PATH, placesAnswer('response.search-last-page.json'));
    const r = await client(graph).searchText({ keyword: 'dental clinic', location: 'Indore', pageSize: 20, pageToken: 'AeCrKXsFixtureNextPageToken_page2' });
    expect(graph.requests[0]!.body).toEqual({ textQuery: 'dental clinic in Indore', pageSize: 20, pageToken: 'AeCrKXsFixtureNextPageToken_page2', languageCode: 'en', regionCode: 'IN' });
    expect(r).toMatchObject({ ok: true, data: { nextPageToken: null } });
  });

  it('an answer with no match is an empty page', async () => {
    const graph = new FakeGraph().on('POST', SEARCH_PATH, placesAnswer('response.search-empty.json'));
    expect(await client(graph).searchText({ keyword: 'zzzz', location: 'Indore', pageSize: 20 })).toEqual({ ok: true, data: { places: [], nextPageToken: null } });
  });

  it.each([
    ['error.400-api-key-invalid.json', 'auth', 'API_KEY_INVALID'],
    ['error.400-invalid-argument.json', 'invalid-argument', 'INVALID_ARGUMENT'],
    ['error.403-permission-denied.json', 'permission', 'SERVICE_DISABLED'],
    ['error.429-resource-exhausted.json', 'rate-limited', 'RATE_LIMIT_EXCEEDED'],
    ['error.503-unavailable.json', 'unavailable', 'UNAVAILABLE'],
  ] as const)('%s is classified %s', async (fixture, kind, reason) => {
    const graph = new FakeGraph().on('POST', SEARCH_PATH, placesAnswer(fixture));
    const r = await client(graph).searchText({ keyword: 'gym', location: 'Bhopal', pageSize: 20 });
    expect(r).toMatchObject({ ok: false, kind, reason, status: placesSources().files[fixture]!.httpStatus });
  });

  it('honours Retry-After on 429, and a thrown request is unreachable', async () => {
    const graph = new FakeGraph().on('POST', SEARCH_PATH, placesAnswer('error.429-resource-exhausted.json', { 'retry-after': '30' }), { throw: networkError('ECONNRESET') });
    const c = client(graph);
    expect(await c.searchText({ keyword: 'gym', location: 'Bhopal', pageSize: 20 })).toMatchObject({ ok: false, kind: 'rate-limited', retryAfterMs: 30_000 });
    expect(await c.searchText({ keyword: 'gym', location: 'Bhopal', pageSize: 20 })).toMatchObject({ ok: false, kind: 'unreachable', status: null, message: 'Google Places could not be reached (ECONNRESET).' });
  });

  it('a 200 that is not the documented shape is rejected, never a fabricated page', async () => {
    const graph = new FakeGraph().on('POST', SEARCH_PATH, { status: 200, body: { places: 'not a list' } }, { status: 200, body: 'not json at all' });
    const c = client(graph);
    expect(await c.searchText({ keyword: 'gym', location: 'Bhopal', pageSize: 20 })).toMatchObject({ ok: false, kind: 'rejected' });
    expect(await c.searchText({ keyword: 'gym', location: 'Bhopal', pageSize: 20 })).toMatchObject({ ok: false, kind: 'rejected' });
  });

  it('never returns the API key in any text, even when Google echoes it', async () => {
    const echo = { error: { code: 400, message: `API key not valid: ${PLACES_KEY}`, status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } };
    const graph = new FakeGraph().on('POST', SEARCH_PATH, { status: 400, body: echo }, { throw: networkError('ENOTFOUND', `getaddrinfo ENOTFOUND ${PLACES_KEY}`) });
    const c = client(graph);
    for (let i = 0; i < 2; i += 1) {
      const r = await c.searchText({ keyword: 'gym', location: 'Bhopal', pageSize: 20 });
      expect(JSON.stringify(r)).not.toContain(PLACES_KEY);
    }
  });
});

describe('Place Details and the connection test', () => {
  it('GETs one place by ID with the unprefixed mask', async () => {
    const graph = new FakeGraph().on('GET', DETAILS_PATH, placesAnswer('response.place-details.json'), placesAnswer('error.404-not-found.json'));
    const c = client(graph);
    const r = await c.getPlace('ChIJF1nderFixtureRoyalDental02', { keyword: 'dentist', location: 'Indore' });
    const req = graph.requests[0]!;
    expect(req.url).toBe('https://places.googleapis.com/v1/places/ChIJF1nderFixtureRoyalDental02?languageCode=en&regionCode=IN');
    expect(req.method).toBe('GET');
    expect(req.headers['x-goog-fieldmask']).toBe(PLACES_DETAILS_FIELD_MASK);
    expect(req.headers['x-goog-api-key']).toBe(PLACES_KEY);
    expect(r).toMatchObject({ ok: true, data: { placeId: 'ChIJF1nderFixtureRoyalDental02', rating: 4.2, reviewCount: 41, websiteListed: false } });
    expect(await c.getPlace('ChIJF1nderFixtureRoyalDental02', { keyword: 'dentist', location: 'Indore' })).toMatchObject({ ok: false, kind: 'not-found' });
    // An ID that is not a URL-safe token never reaches a URL.
    expect(await c.getPlace('../../v1/other', { keyword: 'x', location: 'y' })).toMatchObject({ ok: false, kind: 'invalid-argument' });
    expect(graph.requests).toHaveLength(2);
  });

  it('the connection test asks for place IDs only, one result', async () => {
    const graph = new FakeGraph().on('POST', SEARCH_PATH, { status: 200, body: { places: [{ id: 'ChIJF1nderFixtureSmileDental01' }] } });
    expect(await client(graph).checkConnection()).toEqual({ ok: true, data: { placeCount: 1 } });
    expect(graph.requests[0]!.headers['x-goog-fieldmask']).toBe('places.id');
    expect(graph.requests[0]!.body).toMatchObject({ pageSize: 1 });
  });
});

describe('helpers', () => {
  it('addressParts falls back sensibly and never guesses a PIN code', () => {
    expect(addressParts([{ longText: 'Sehore', types: ['administrative_area_level_3'] }, { shortText: 'MP', types: ['administrative_area_level_1'] }])).toEqual({ city: 'Sehore', state: 'MP', pincode: null });
    expect(addressParts(undefined)).toEqual({ city: null, state: null, pincode: null });
  });

  it('builds a Maps link from the place ID only', () => {
    expect(placesMapsLink('ChIJF1nderFixtureSmileDental01', 'dental clinic Indore')).toBe('https://www.google.com/maps/search/?api=1&query=dental+clinic+Indore&query_place_id=ChIJF1nderFixtureSmileDental01');
    expect(placesMapsLink('javascript:alert(1)', 'x')).toBeNull();
  });
});

describe('DEMO', () => {
  it('a client wired in DEMO is blocked before any socket', async () => {
    resetOutboundAttempts();
    const c = createGooglePlacesClient({ mode: 'demo', apiKey: PLACES_KEY, clock });
    const r = await c.searchText({ keyword: 'gym', location: 'Bhopal', pageSize: 20 });
    expect(r).toMatchObject({ ok: false, kind: 'unreachable' });
    expect(outboundAttempts()).toEqual([expect.objectContaining({ host: 'places.googleapis.com', mode: 'demo', blocked: true })]);
  });
});
