// ADR-118 (DEMO provider, slice F1): `demoPlace` and the page helpers are a pure, deterministic
// stand-in for Places Text Search that echoes the person's keyword and location: the category
// follows the keyword, the city the location (Indore and Bhopal with their own localities and PIN
// codes), phones are valid Indian mobiles in the demo style, about half the listings have no
// website, and a simulated place ID rebuilds its listing for a DEMO Refresh.
import { describe, expect, it } from 'vitest';
import { parsePhone } from '@/lib/phone';
import { DEMO_PLACES_DOMAIN, DEMO_PLACES_PAGE_SIZE, demoPlace, demoPlaceById, demoPlaceSeed, demoPlacesPage, demoPlacesTotal, demoWebsiteEmails } from '@/lib/demo/places';

const INDORE_DENTAL = { keyword: 'Dental clinic', location: 'Indore' };

function allOf(query: { keyword: string; location: string }) {
  const out = [];
  for (let p = 0; p < 3; p += 1) out.push(...demoPlacesPage(query, p).places);
  return out;
}

describe('demoPlace', () => {
  it('is deterministic per keyword, location and position, and ignores case and spacing', () => {
    const a = demoPlace(demoPlaceSeed(INDORE_DENTAL, 3), INDORE_DENTAL);
    const b = demoPlace(demoPlaceSeed({ keyword: '  dental   CLINIC ', location: 'indore ' }, 3), { keyword: '  dental   CLINIC ', location: 'indore ' });
    expect(b).toEqual(a);
    expect(demoPlace(demoPlaceSeed(INDORE_DENTAL, 4), INDORE_DENTAL).placeId).not.toBe(a.placeId);
    expect(demoPlace(demoPlaceSeed({ keyword: 'Dental clinic', location: 'Bhopal' }, 3), { keyword: 'Dental clinic', location: 'Bhopal' }).placeId).not.toBe(a.placeId);
  });

  it('derives the category from the keyword', () => {
    const cases: Array<[string, string]> = [
      ['restaurants', 'Restaurant'],
      ['dentist', 'Dental clinic'],
      ['beauty parlour', 'Beauty salon'],
      ['gym', 'Gym'],
      ['saree boutique', 'Clothing boutique'],
      ['coaching classes', 'Coaching centre'],
      ['bakery', 'Bakery'],
      ['plumbers', 'Plumbers'],
    ];
    for (const [keyword, category] of cases) {
      const q = { keyword, location: 'Indore' };
      expect(demoPlace(demoPlaceSeed(q, 0), q).category, keyword).toBe(category);
    }
  });

  it('places Indore and Bhopal results in their own localities with Madhya Pradesh PIN codes', () => {
    for (const [location, city, pinPrefix] of [
      ['Indore', 'Indore', /^45[23]\d{3}$/],
      ['Vijay Nagar, Indore', 'Indore', /^45[23]\d{3}$/],
      ['bhopal', 'Bhopal', /^462\d{3}$/],
    ] as const) {
      const q = { keyword: 'salon', location };
      for (const p of allOf(q)) {
        expect(p.city).toBe(city);
        expect(p.state).toBe('Madhya Pradesh');
        expect(p.pincode).toMatch(pinPrefix);
        expect(p.address).toContain(`${city}, Madhya Pradesh ${p.pincode}`);
      }
    }
  });

  it('uses a generic locality for other places, with the state of a known city', () => {
    const pune = allOf({ keyword: 'gym', location: 'Pune' });
    expect(pune.every((p) => p.city === 'Pune' && p.state === 'Maharashtra' && /^411\d{3}$/.test(p.pincode))).toBe(true);
    const town = allOf({ keyword: 'gym', location: 'sehore, mp' });
    expect(town.every((p) => p.city === 'Sehore' && p.state === null && /^[1-8]\d{5}$/.test(p.pincode))).toBe(true);
  });

  it('gives valid Indian mobile numbers, about half the listings no website, and some without phone or rating', () => {
    const places = [...allOf(INDORE_DENTAL), ...allOf({ keyword: 'restaurant', location: 'Indore' }), ...allOf({ keyword: 'gym', location: 'Bhopal' })];
    expect(places.length).toBeGreaterThan(70);
    for (const p of places) {
      if (p.phone !== null) {
        expect(p.phone).toMatch(/^\+91 [6-9]\d{4} \d{5}$/);
        expect(parsePhone(p.phone).valid).toBe(true);
      }
      expect(p.websiteListed).toBe(p.website !== null);
      if (p.website) expect(p.website).toMatch(new RegExp(`^https://[a-z0-9]+\\.${DEMO_PLACES_DOMAIN.replace('.', '\\.')}$`));
      if (p.rating !== null) {
        expect(p.rating).toBeGreaterThanOrEqual(3.2);
        expect(p.rating).toBeLessThanOrEqual(4.9);
        expect(p.reviewCount).toBeGreaterThanOrEqual(3);
      } else expect(p.reviewCount).toBeNull();
    }
    const noWebsite = places.filter((p) => !p.websiteListed).length / places.length;
    expect(noWebsite).toBeGreaterThan(0.35);
    expect(noWebsite).toBeLessThan(0.65);
    expect(places.some((p) => p.phone === null)).toBe(true);
    expect(places.some((p) => p.rating === null)).toBe(true);
  });
});

describe('demo pages', () => {
  it('serves 20 per page, at most three pages, and the total of the query', () => {
    const total = demoPlacesTotal(INDORE_DENTAL);
    expect(total).toBeGreaterThanOrEqual(24);
    expect(total).toBeLessThanOrEqual(60);
    const first = demoPlacesPage(INDORE_DENTAL, 0);
    expect(first.places).toHaveLength(DEMO_PLACES_PAGE_SIZE);
    expect(first.hasNextPage).toBe(true);
    const all = allOf(INDORE_DENTAL);
    expect(all).toHaveLength(total);
    expect(new Set(all.map((p) => p.placeId)).size).toBe(total);
    expect(demoPlacesPage(INDORE_DENTAL, 3)).toEqual({ places: [], hasNextPage: false });
    const last = Math.ceil(total / DEMO_PLACES_PAGE_SIZE) - 1;
    expect(demoPlacesPage(INDORE_DENTAL, last).hasNextPage).toBe(false);
  });

  it('rebuilds a listing from its simulated place ID and the query it was found with', () => {
    const p = demoPlacesPage(INDORE_DENTAL, 1).places[5]!;
    expect(p.placeId).toMatch(/^ChIJdemo-[0-9a-z]+-\d+$/);
    expect(demoPlaceById(p.placeId, INDORE_DENTAL)).toEqual(p);
    expect(demoPlaceById(p.placeId, { keyword: 'gym', location: 'Indore' })).toBeNull();
    expect(demoPlaceById('ChIJN1t_tDeuEmsRUsoyG83frY4', INDORE_DENTAL)).toBeNull();
  });
});

describe('demoWebsiteEmails', () => {
  it('finds nothing without a website and @demo-leads.in addresses on most sites', () => {
    const places = allOf(INDORE_DENTAL);
    for (const p of places.filter((x) => !x.websiteListed)) expect(demoWebsiteEmails(p)).toEqual([]);
    const withSite = places.filter((x) => x.websiteListed);
    const found = withSite.flatMap((p) => demoWebsiteEmails(p));
    expect(found.length).toBeGreaterThan(0);
    for (const e of found) {
      expect(e.address.endsWith(`@${DEMO_PLACES_DOMAIN}`)).toBe(true);
      expect(['ROLE', 'PERSONAL']).toContain(e.kind);
      expect(e.sourceUrl.startsWith('https://')).toBe(true);
    }
    expect(demoWebsiteEmails(withSite[0]!)).toEqual(demoWebsiteEmails(withSite[0]!));
  });
});
