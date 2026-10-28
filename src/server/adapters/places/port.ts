/**
 * The Lead Finder's places port (ADR-118, slice F1): Text Search by keyword and location, one
 * page per call, and Place Details by place ID for Refresh. Two implementations, chosen only by
 * `adapters/registry.ts`:
 *  - `google-places.ts` (LIVE): Google Places API (New) through `outboundRequest`;
 *  - `demo.ts` (DEMO): the deterministic simulated directory of `src/lib/demo/places.ts`, which
 *    never contacts anything and flags every listing simulated.
 *
 * The field mask is fixed here, once, for both calls: only what the finder shows and imports.
 * Reviews and photos are never requested (they bring author-attribution duties and are named in
 * the Maps terms' "copy and save" prohibition); latitude and longitude are never requested or
 * stored. `googleMapsUri` is requested as ADR-118 lists it but never stored: a Maps link is built
 * from the place ID (`placesMapsLink`).
 */

/** The Place fields of ADR-118 (without the `places.` prefix of a Text Search mask). */
export const PLACE_FIELDS = [
  'id',
  'displayName',
  'primaryTypeDisplayName',
  'nationalPhoneNumber',
  'internationalPhoneNumber',
  'websiteUri',
  'rating',
  'userRatingCount',
  'formattedAddress',
  'addressComponents',
  'googleMapsUri',
  'attributions',
] as const;

/** `X-Goog-FieldMask` of Text Search: the place fields plus the next page token. */
export const PLACES_SEARCH_FIELD_MASK = [...PLACE_FIELDS.map((f) => `places.${f}`), 'nextPageToken'].join(',');
/** `X-Goog-FieldMask` of Place Details (Refresh): the same fields, unprefixed. */
export const PLACES_DETAILS_FIELD_MASK = PLACE_FIELDS.join(',');

/** Results per Text Search page (the API's maximum) and pages per query (ADR-118: up to 60). */
export const PLACES_PAGE_SIZE = 20;
export const PLACES_MAX_PAGES = 3;

export type PlaceAttribution = { provider: string; providerUri: string | null };

/** One place as the finder stores it: the documented fields, normalized; null when Google sent none. */
export type PlaceRecord = {
  placeId: string;
  name: string | null;
  category: string | null;
  /** The international form when given (it parses without a region), else the national one. */
  phone: string | null;
  website: string | null;
  /** False when the listing has no website (`websiteUri` absent although requested, ADR-119). */
  websiteListed: boolean;
  /** Stars as given (one decimal). */
  rating: number | null;
  reviewCount: number | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  /** Provider attributions returned with the place; shown with its content in LIVE. */
  attributions: PlaceAttribution[];
};

export type PlacesSearchRequest = {
  keyword: string;
  location: string;
  /** The `nextPageToken` of the previous page; absent for the first page. */
  pageToken?: string | null;
  pageSize: number;
};

export type PlacesSearchPage = { places: PlaceRecord[]; nextPageToken: string | null };

export type PlacesFailureKind =
  /** The key was rejected (API_KEY_INVALID, 401): the person has to enter a new key. */
  | 'auth'
  /** 403 PERMISSION_DENIED: the Places API (New) is not enabled, billing is off, or the key is restricted. */
  | 'permission'
  /** 400 INVALID_ARGUMENT other than the key (a bad page token or query). */
  | 'invalid-argument'
  /** 404: Place Details for an ID Google no longer knows. */
  | 'not-found'
  /** 429 RESOURCE_EXHAUSTED: quota or rate. */
  | 'rate-limited'
  /** 5xx. */
  | 'unavailable'
  /** No answer at all (DNS, connect, timeout). */
  | 'unreachable'
  /** Anything else, including an answer that is not the documented shape. */
  | 'rejected';

export type PlacesCall<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      kind: PlacesFailureKind;
      status: number | null;
      /** Google's `error.status` or ErrorInfo reason (API_KEY_INVALID, PERMISSION_DENIED, ...), when given. */
      reason: string | null;
      /** Bounded, redacted, key-free text for logs and the run's error. */
      message: string;
      retryAfterMs?: number;
    };

/** Search terms a DEMO Refresh needs to rebuild a simulated listing (LIVE ignores them). */
export type PlaceLookupHint = { keyword: string; location: string };

export type PlacesProvider = {
  readonly label: 'google-places' | 'demo-places';
  readonly simulated: boolean;
  searchText(request: PlacesSearchRequest): Promise<PlacesCall<PlacesSearchPage>>;
  getPlace(placeId: string, hint: PlaceLookupHint): Promise<PlacesCall<PlaceRecord>>;
};

/** `<keyword> in <location>`, the Text Search query (ADR-118). */
export function placesTextQuery(keyword: string, location: string): string {
  return `${keyword.trim()} in ${location.trim()}`;
}

/** Place IDs are URL-safe tokens; anything else never reaches a URL. */
export const PLACE_ID_RE = /^[A-Za-z0-9_-]{1,512}$/;

/**
 * A Google Maps link built from the place ID (Maps URLs, `query_place_id`), never Google's own
 * `googleMapsUri`, so the link survives the 24-hour purge. `query` is what Maps falls back to.
 */
export function placesMapsLink(placeId: string, query: string): string | null {
  if (!PLACE_ID_RE.test(placeId)) return null;
  const params = new URLSearchParams({ api: '1', query: query.trim() === '' ? placeId : query.trim(), query_place_id: placeId });
  return `https://www.google.com/maps/search/?${params.toString()}`;
}
