/**
 * The DEMO places provider (ADR-118, slice F1): the simulated directory of `src/lib/demo/places.ts`
 * behind the places port. It never contacts anything (zero outbound), labels itself
 * `demo-places`, and every listing it returns is simulated. Page tokens are `demo-page-<n>`, so a
 * run walks up to three pages exactly like Text Search; Refresh rebuilds a listing from its
 * simulated place ID and the keyword and location it was found with.
 */
import { DEMO_PLACES_MAX_PAGES, demoPlaceById, demoPlacesPage, type DemoPlace } from '@/lib/demo/places';
import type { PlaceRecord, PlacesCall, PlacesProvider, PlacesSearchPage } from './port';

const TOKEN_RE = /^demo-page-(\d)$/;

function toRecord(p: DemoPlace): PlaceRecord {
  return {
    placeId: p.placeId,
    name: p.name,
    category: p.category,
    phone: p.phone,
    website: p.website,
    websiteListed: p.websiteListed,
    rating: p.rating,
    reviewCount: p.reviewCount,
    address: p.address,
    city: p.city,
    state: p.state,
    pincode: p.pincode,
    attributions: [],
  };
}

export function createDemoPlacesProvider(): PlacesProvider {
  return {
    label: 'demo-places',
    simulated: true,
    async searchText(request): Promise<PlacesCall<PlacesSearchPage>> {
      let page = 0;
      if (request.pageToken) {
        const m = TOKEN_RE.exec(request.pageToken);
        if (!m || Number(m[1]) >= DEMO_PLACES_MAX_PAGES) return { ok: false, kind: 'invalid-argument', status: 400, reason: 'INVALID_ARGUMENT', message: 'The page token is not one this directory issued.' };
        page = Number(m[1]);
      }
      const result = demoPlacesPage({ keyword: request.keyword, location: request.location }, page);
      return { ok: true, data: { places: result.places.slice(0, request.pageSize).map(toRecord), nextPageToken: result.hasNextPage ? `demo-page-${page + 1}` : null } };
    },
    async getPlace(placeId, hint): Promise<PlacesCall<PlaceRecord>> {
      const place = demoPlaceById(placeId, hint);
      if (!place) return { ok: false, kind: 'not-found', status: 404, reason: 'NOT_FOUND', message: 'The simulated directory has no listing with this ID.' };
      return { ok: true, data: toRecord(place) };
    },
  };
}
