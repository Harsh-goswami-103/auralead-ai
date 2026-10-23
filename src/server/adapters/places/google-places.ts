/**
 * Google Places API (New) adapter (ADR-118, slice F1). LIVE only: built by `adapters/registry.ts`
 * from the workspace's GOOGLE_PLACES integration key, never in DEMO; every request goes through
 * `adapters/http/outbound.ts`, which refuses every host in DEMO.
 *
 * Calls (one HTTP request each; the finder makes one per job):
 *  - Text Search: `POST https://places.googleapis.com/v1/places:searchText` with the JSON body
 *    `{ textQuery: "<keyword> in <location>", pageSize: 20, pageToken?, languageCode: "en",
 *    regionCode: "IN" }` and the headers `X-Goog-Api-Key` and `X-Goog-FieldMask` (the ADR-118 mask
 *    plus `nextPageToken`, port.ts). A next page repeats the same body with `pageToken`.
 *  - Place Details (Refresh): `GET https://places.googleapis.com/v1/places/<placeId>` with the same
 *    fields unprefixed, `languageCode=en`, `regionCode=IN`.
 *  - Connection test: one Text Search asking for place IDs only (`places.id`, page size 1).
 *
 * The answer `places[]` carries `id`, `displayName.text`, `primaryTypeDisplayName.text`,
 * `nationalPhoneNumber`, `internationalPhoneNumber`, `websiteUri`, `rating`, `userRatingCount`,
 * `formattedAddress`, `addressComponents[{longText, shortText, types}]` (city from `locality`,
 * state from `administrative_area_level_1`, PIN code from `postal_code`), `googleMapsUri` (never
 * stored) and `attributions[{provider, providerUri}]`; `nextPageToken` when another page exists.
 *
 * Failures follow Google's error model `{ error: { code, message, status, details[] } }`: 400
 * with ErrorInfo reason API_KEY_INVALID (or 401) is `auth`; other 400 INVALID_ARGUMENT
 * `invalid-argument`; 403 PERMISSION_DENIED `permission` (API not enabled, billing off, key
 * restricted); 404 `not-found`; 429 RESOURCE_EXHAUSTED `rate-limited` (Retry-After honoured);
 * 5xx `unavailable`; a thrown request `unreachable`. The API key travels only in its header and
 * is scrubbed from every text this module returns.
 *
 * Shapes follow Google's published references (developers.google.com/maps/documentation/places/
 * web-service, read through search results on PLACES_CHECKED_ON) and are UNVERIFIED until a live
 * check: tests/fixtures/places/documented-shape holds documented-shape fixtures with
 * `verified: false`, never recorded traffic.
 */
import type { Clock } from '@/lib/clock';
import { redactText } from '@/lib/redact';
import { outboundFailureLabel, outboundRequest, type OutboundMode, type OutboundRequest, type OutboundResponse } from '../http/outbound';
import {
  PLACE_ID_RE,
  PLACES_DETAILS_FIELD_MASK,
  PLACES_SEARCH_FIELD_MASK,
  placesTextQuery,
  type PlaceAttribution,
  type PlaceLookupHint,
  type PlaceRecord,
  type PlacesCall,
  type PlacesFailureKind,
  type PlacesProvider,
  type PlacesSearchPage,
  type PlacesSearchRequest,
} from './port';

export const PLACES_API_BASE_URL = 'https://places.googleapis.com';
/** The day the request and answer shapes above were last checked against Google's documentation. */
export const PLACES_CHECKED_ON = '2026-10-23';
export const PLACES_LANGUAGE_CODE = 'en';
export const PLACES_REGION_CODE = 'IN';
/** The connection test asks for place IDs only. */
export const PLACES_CHECK_FIELD_MASK = 'places.id';
const TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
const MESSAGE_MAX = 300;

export type PlacesHttp = (url: string, init: OutboundRequest) => Promise<OutboundResponse>;

export type GooglePlacesOptions = {
  /** The process mode; outbound.ts refuses every host in DEMO. */
  mode: OutboundMode;
  apiKey: string;
  clock: Clock;
  /** Test seam (scripted answers); production uses outbound.ts. */
  http?: PlacesHttp;
  /** Test seam (a local fake server); production uses places.googleapis.com. */
  baseUrl?: string;
  timeoutMs?: number;
};

export type GooglePlacesClient = PlacesProvider & {
  /** One Text Search asking for place IDs only: does Google accept this key for the Places API (New)? */
  checkConnection(): Promise<PlacesCall<{ placeCount: number }>>;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t === '' ? null : t;
}

function localizedText(value: unknown): string | null {
  return text(record(value).text);
}

function headerValue(headers: OutboundResponse['headers'], name: string): string | null {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return typeof v === 'string' ? v : null;
}

function retryAfter(headers: OutboundResponse['headers'], now: Date): number | undefined {
  const raw = headerValue(headers, 'retry-after');
  if (raw === null || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - now.getTime();
  if (Number.isNaN(ms)) return undefined;
  return Math.min(Math.max(0, Math.ceil(ms)), MAX_RETRY_AFTER_MS);
}

/** City, state and PIN code from `addressComponents` (locality; administrative_area_level_1; postal_code). */
export function addressParts(components: unknown): { city: string | null; state: string | null; pincode: string | null } {
  const list = Array.isArray(components) ? components.map(record) : [];
  const find = (...types: string[]) => {
    for (const type of types) {
      const hit = list.find((c) => Array.isArray(c.types) && (c.types as unknown[]).includes(type));
      const value = hit ? (text(hit.longText) ?? text(hit.shortText)) : null;
      if (value) return value;
    }
    return null;
  };
  const postal = find('postal_code');
  return {
    city: find('locality', 'administrative_area_level_3', 'postal_town', 'administrative_area_level_2'),
    state: find('administrative_area_level_1'),
    pincode: postal && postal.length <= 12 ? postal : null,
  };
}

function attributionsOf(value: unknown): PlaceAttribution[] {
  if (!Array.isArray(value)) return [];
  const out: PlaceAttribution[] = [];
  for (const raw of value) {
    const a = record(raw);
    const provider = text(a.provider);
    if (!provider) continue;
    out.push({ provider: provider.slice(0, 200), providerUri: text(a.providerUri)?.slice(0, 2048) ?? null });
  }
  return out.slice(0, 10);
}

/** One `Place` of a Text Search or Details answer, normalized; null without an id. */
export function parsePlace(value: unknown): PlaceRecord | null {
  const p = record(value);
  const placeId = text(p.id);
  if (!placeId || !PLACE_ID_RE.test(placeId)) return null;
  const rating = typeof p.rating === 'number' && Number.isFinite(p.rating) && p.rating >= 0 && p.rating <= 5 ? p.rating : null;
  const count = typeof p.userRatingCount === 'number' && Number.isInteger(p.userRatingCount) && p.userRatingCount >= 0 ? p.userRatingCount : null;
  const website = text(p.websiteUri);
  return {
    placeId,
    name: localizedText(p.displayName),
    category: localizedText(p.primaryTypeDisplayName),
    phone: text(p.internationalPhoneNumber) ?? text(p.nationalPhoneNumber),
    website,
    websiteListed: website !== null,
    rating,
    reviewCount: count,
    address: text(p.formattedAddress),
    ...addressParts(p.addressComponents),
    attributions: attributionsOf(p.attributions),
  };
}

/** Classifies an error answer from Google's error model (exported for the tests). */
export function classifyPlacesError(status: number, body: string): { kind: PlacesFailureKind; reason: string | null; message: string } {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = record(JSON.parse(body));
  } catch {
    parsed = {};
  }
  const error = record(parsed.error);
  const statusText = text(error.status);
  const reasons = Array.isArray(error.details) ? error.details.map((d) => text(record(d).reason)).filter((r): r is string => r !== null) : [];
  const message = text(error.message) ?? `HTTP ${status}`;
  let kind: PlacesFailureKind;
  if (status === 401 || reasons.includes('API_KEY_INVALID') || reasons.includes('API_KEY_EXPIRED')) kind = 'auth';
  else if (status === 403) kind = 'permission';
  else if (status === 404) kind = 'not-found';
  else if (status === 429) kind = 'rate-limited';
  else if (status >= 500) kind = 'unavailable';
  else if (status === 400) kind = 'invalid-argument';
  else kind = 'rejected';
  return { kind, reason: reasons[0] ?? statusText, message };
}

export function createGooglePlacesClient(options: GooglePlacesOptions): GooglePlacesClient {
  if (options.apiKey.trim().length === 0) throw new RangeError('Google Places API key is empty');
  const http: PlacesHttp = options.http ?? ((url, init) => outboundRequest(options.mode, url, init, options.clock.now()));
  const base = (options.baseUrl ?? PLACES_API_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const key = options.apiKey;
  const scrub = (t: string) => redactText(t.split(key).join('[REDACTED]')).slice(0, MESSAGE_MAX);

  async function call<T>(method: 'GET' | 'POST', url: string, fieldMask: string, body: unknown, read: (json: Record<string, unknown>) => T | null): Promise<PlacesCall<T>> {
    const headers: Record<string, string> = { 'x-goog-api-key': key, 'x-goog-fieldmask': fieldMask, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: OutboundResponse;
    try {
      res = await http(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), headersTimeoutMs: timeoutMs, bodyTimeoutMs: timeoutMs });
    } catch (error) {
      return { ok: false, kind: 'unreachable', status: null, reason: null, message: scrub(`Google Places could not be reached (${outboundFailureLabel(error)}).`) };
    }
    if (res.statusCode >= 200 && res.statusCode < 300) {
      let json: unknown;
      try {
        json = JSON.parse(res.body === '' ? '{}' : res.body);
      } catch {
        return { ok: false, kind: 'rejected', status: res.statusCode, reason: null, message: 'Google Places answered with a body that is not JSON.' };
      }
      const data = read(record(json));
      if (data !== null) return { ok: true, data };
      return { ok: false, kind: 'rejected', status: res.statusCode, reason: null, message: 'The Google Places answer did not have the documented shape.' };
    }
    const c = classifyPlacesError(res.statusCode, res.body);
    const after = retryAfter(res.headers, options.clock.now());
    return { ok: false, kind: c.kind, status: res.statusCode, reason: c.reason, message: scrub(c.message), ...(after !== undefined ? { retryAfterMs: after } : {}) };
  }

  const searchBody = (request: { keyword: string; location: string; pageSize: number; pageToken?: string | null }) => ({
    textQuery: placesTextQuery(request.keyword, request.location),
    pageSize: request.pageSize,
    ...(request.pageToken ? { pageToken: request.pageToken } : {}),
    languageCode: PLACES_LANGUAGE_CODE,
    regionCode: PLACES_REGION_CODE,
  });

  return {
    label: 'google-places',
    simulated: false,
    searchText(request: PlacesSearchRequest) {
      if (!Number.isInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > 20) throw new RangeError('pageSize must be 1..20');
      return call<PlacesSearchPage>('POST', `${base}/v1/places:searchText`, PLACES_SEARCH_FIELD_MASK, searchBody(request), (json) => {
        // An answer with no match at all is `{}`: no places, no next page.
        if (json.places !== undefined && !Array.isArray(json.places)) return null;
        const places = (Array.isArray(json.places) ? json.places : []).map(parsePlace).filter((p): p is PlaceRecord => p !== null);
        const token = text(json.nextPageToken);
        return { places, nextPageToken: token };
      });
    },
    getPlace(placeId: string, _hint: PlaceLookupHint) {
      if (!PLACE_ID_RE.test(placeId)) return Promise.resolve({ ok: false, kind: 'invalid-argument', status: null, reason: null, message: 'not a place ID' } as const);
      const query = new URLSearchParams({ languageCode: PLACES_LANGUAGE_CODE, regionCode: PLACES_REGION_CODE });
      return call<PlaceRecord>('GET', `${base}/v1/places/${encodeURIComponent(placeId)}?${query.toString()}`, PLACES_DETAILS_FIELD_MASK, undefined, (json) => parsePlace(json));
    },
    checkConnection() {
      return call<{ placeCount: number }>('POST', `${base}/v1/places:searchText`, PLACES_CHECK_FIELD_MASK, { textQuery: 'post office in India', pageSize: 1, languageCode: PLACES_LANGUAGE_CODE, regionCode: PLACES_REGION_CODE }, (json) =>
        json.places !== undefined && !Array.isArray(json.places) ? null : { placeCount: Array.isArray(json.places) ? json.places.length : 0 },
      );
    },
  };
}
