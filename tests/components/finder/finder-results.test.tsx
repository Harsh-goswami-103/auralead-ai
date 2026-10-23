/**
 * ADR-118 (slice F1): the results grid of a finder run. It shows the "No website listed" chip, the
 * rating with its reviews, phone, address with city and PIN code, a Maps link for LIVE rows only,
 * the emails found, and the lead link of an imported row; filters are links that keep the run;
 * selected rows are imported with one POST (CSRF, request key, ids); "Download Excel" links to the
 * run's file, or says why it is not offered; an expired row says "Details expired" and can be
 * refreshed. LIVE shows the Google Maps attribution and terms line; DEMO the Simulated chip.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { CsrfProvider } from '@/components/patterns/csrf';
import { FinderResults } from '@/components/finder/FinderResults';
import { PlacesAttribution } from '@/components/finder/PlacesAttribution';
import type { FinderResultDto, FinderRunView } from '@/server/services/lead-finder/runs';
import { GOOGLE_MAPS_TERMS_LINE } from '@/server/services/lead-finder/schemas';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function result(over: Partial<FinderResultDto>): FinderResultDto {
  return {
    id: 'res_1',
    placeId: 'ChIJdemo-abc-1',
    keyword: 'restaurants',
    location: 'Indore',
    hasDetails: true,
    erased: false,
    name: 'Shree Kitchen',
    category: 'Restaurant',
    phone: '+91 98260 11111',
    hasPhone: true,
    website: null,
    websiteHref: null,
    websiteListed: false,
    rating: 4.3,
    reviewCount: 128,
    address: '12, Vijay Nagar, Indore, Madhya Pradesh 452010, India',
    city: 'Indore',
    state: 'Madhya Pradesh',
    pincode: '452010',
    attributions: [],
    mapsHref: null,
    emails: [],
    emailStatus: 'NOT_REQUESTED',
    simulated: true,
    importedLeadId: null,
    importedAt: null,
    ...over,
  };
}

function view(results: FinderResultDto[], simulated = true, over: Partial<FinderRunView> = {}): FinderRunView {
  return {
    run: {
      id: 'run_1',
      status: 'SUCCEEDED',
      keywords: ['restaurants'],
      locations: ['Indore'],
      maxPerQuery: 20,
      extractEmails: false,
      blacklistCount: 0,
      cellsTotal: 1,
      cellsDone: 1,
      resultsFound: results.length,
      emailsFound: 0,
      emailsPending: 0,
      simulated,
      errorCode: null,
      createdAt: '2026-10-23T06:00:00.000Z',
      startedAt: '2026-10-23T06:00:00.000Z',
      finishedAt: '2026-10-23T06:00:05.000Z',
      cancelledAt: null,
      requestedByViewer: true,
    },
    results,
    filters: { noWebsite: false, hasPhone: false, notImported: false },
    page: 1,
    pageCount: 1,
    total: results.length,
    counts: { all: results.length, noWebsite: results.filter((r) => !r.websiteListed).length, hasPhone: results.filter((r) => r.hasPhone).length, notImported: results.filter((r) => !r.importedLeadId).length },
    attributions: [],
    ...over,
  };
}

const ROWS = [
  result({ id: 'res_1' }),
  result({ id: 'res_2', name: 'Royal Dhaba', websiteListed: true, website: 'https://royal.demo-leads.in', websiteHref: 'https://royal.demo-leads.in', rating: null, reviewCount: null, emails: [{ address: 'hello.royal@demo-leads.in', sourceUrl: 'https://royal.demo-leads.in/contact', kind: 'ROLE' }], emailStatus: 'FOUND' }),
  result({ id: 'res_3', name: 'Lotus Bhojanalaya', importedLeadId: 'lead_9', importedAt: '2026-10-23T06:10:00.000Z' }),
];

function renderResults(v: FinderRunView, gates: { importGate?: null | { category: 'permission'; reason: string }; exportGate?: null | { category: 'permission'; reason: string } } = {}) {
  return render(
    <CsrfProvider token="csrf-token-1">
      <FinderResults view={v} workspaceSlug="codecraft-web" importGate={gates.importGate ?? null} exportGate={gates.exportGate ?? null} refreshGate={null} />
    </CsrfProvider>,
  );
}

const row = (id: string) => document.querySelector(`[data-result-id="${id}"]`) as HTMLElement;

describe('FinderResults', () => {
  it('shows the listing columns, the No website chip, the emails and the lead link', () => {
    renderResults(view(ROWS));
    expect(within(row('res_1')).getByText('No website listed')).toBeTruthy();
    expect(row('res_1').querySelector('[data-no-website]')).not.toBeNull();
    expect(within(row('res_1')).getByLabelText('4.3 of 5, 128 reviews')).toBeTruthy();
    expect(within(row('res_1')).getByText('+91 98260 11111')).toBeTruthy();
    expect(within(row('res_1')).getByText('Indore · 452010')).toBeTruthy();
    expect(within(row('res_2')).getByRole('link', { name: /royal\.demo-leads\.in/ }).getAttribute('href')).toBe('https://royal.demo-leads.in');
    expect(within(row('res_2')).getByText('Not rated')).toBeTruthy();
    expect(within(row('res_2')).getByText('hello.royal@demo-leads.in')).toBeTruthy();
    expect(within(row('res_3')).getByRole('link', { name: 'Imported' }).getAttribute('href')).toBe('/dashboard/employee/codecraft-web/leads/lead_9');
    expect((within(row('res_3')).getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    // DEMO rows are simulated listings: no Maps link, the Simulated chip, and no Google attribution.
    expect(screen.queryByText('Open in Google Maps')).toBeNull();
    expect(document.querySelectorAll('[data-mode-chip="simulated"]').length).toBeGreaterThan(0);
    expect(document.querySelector('[data-places-attribution="simulated"]')).not.toBeNull();
    expect(screen.queryByText(/Results from Google Maps/)).toBeNull();
  });

  it('filters are links that keep the run and toggle the column filter', () => {
    renderResults(view(ROWS, true, { filters: { noWebsite: true, hasPhone: false, notImported: false } }));
    const noWebsite = document.querySelector('[data-filter="noWebsite"]') as HTMLAnchorElement;
    expect(noWebsite.getAttribute('aria-current')).toBe('true');
    expect(noWebsite.getAttribute('aria-pressed')).toBeNull();
    expect((document.querySelector('[data-filter="hasPhone"]') as HTMLAnchorElement).getAttribute('aria-current')).toBeNull();
    expect(noWebsite.getAttribute('href')).toBe('/dashboard/employee/codecraft-web/finder?run=run_1');
    const hasPhone = document.querySelector('[data-filter="hasPhone"]') as HTMLAnchorElement;
    expect(hasPhone.getAttribute('href')).toBe('/dashboard/employee/codecraft-web/finder?run=run_1&noWebsite=1&hasPhone=1');
  });

  it('imports the selected rows with one POST and refreshes', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ counts: { accepted: 2, duplicate: 0, review: 0, rejected: 0, alreadyImported: 0, detailsExpired: 0 } }), { status: 200 }));
    renderResults(view(ROWS));
    fireEvent.click(screen.getByLabelText('Select every result on this page that is not imported'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Import selected (2)' }));
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/app/finder/runs/run_1/import');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-token-1');
    const body = JSON.parse(init.body as string) as { workspaceSlug: string; resultIds: string[]; requestKey: string };
    expect(body).toMatchObject({ workspaceSlug: 'codecraft-web', resultIds: ['res_1', 'res_2'] });
    expect(body.requestKey).toMatch(/^[0-9a-f]{32}$/);
    expect(toast.success).toHaveBeenCalledWith('Import finished.', { description: '2 new leads' });
    expect(refresh).toHaveBeenCalled();
  });

  it('Download Excel links to the run file for its requester, or says why it is not offered', () => {
    renderResults(view(ROWS));
    expect(screen.getByRole('link', { name: 'Download Excel' }).getAttribute('href')).toBe('/api/app/finder/runs/run_1/export?workspaceSlug=codecraft-web');
    cleanup();
    renderResults(view(ROWS), { exportGate: { category: 'permission', reason: 'Only the person who ran this search can download its file.' }, importGate: { category: 'permission', reason: 'Your assignment here does not include “Edit leads”.' } });
    const download = screen.getByRole('button', { name: 'Download Excel' });
    expect(download.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('Only the person who ran this search can download its file.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import selected' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('an expired row says so, cannot be imported, and can be refreshed', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ refreshed: 1, failed: 0 }), { status: 200 }));
    const expired = result({ id: 'res_x', hasDetails: false, name: null, category: null, phone: null, rating: null, reviewCount: null, address: null, city: null, pincode: null });
    renderResults(view([expired]));
    expect(within(row('res_x')).getByText('Details expired')).toBeTruthy();
    fireEvent.click(within(row('res_x')).getByRole('checkbox'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh details (1)' }));
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/app/finder/runs/run_1/refresh');
    expect(JSON.parse(init.body as string)).toEqual({ workspaceSlug: 'codecraft-web', resultIds: ['res_x'] });
    expect(toast.success).toHaveBeenCalledWith('1 listing refreshed.', expect.anything());
  });

  it('a row whose details an erasure removed says so and can be neither selected nor refreshed', () => {
    const erased = result({ id: 'res_e', hasDetails: false, erased: true, name: null, category: null, phone: null, rating: null, reviewCount: null, address: null, city: null, pincode: null });
    renderResults(view([erased]));
    expect(within(row('res_e')).getByText('Details removed on request')).toBeTruthy();
    expect((within(row('res_e')).getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /Refresh details/ })).toBeNull();
  });

  it('LIVE rows show the Maps link and the Google Maps attribution', () => {
    const live = result({ simulated: false, placeId: 'ChIJF1nderFixtureSmileDental01', mapsHref: 'https://www.google.com/maps/search/?api=1&query=restaurants+Indore&query_place_id=ChIJF1nderFixtureSmileDental01', attributions: [{ provider: 'Partner', providerUri: 'https://partner.example.com/' }] });
    renderResults(view([live], false, { attributions: live.attributions }));
    expect(screen.getByRole('link', { name: 'Open in Google Maps' }).getAttribute('href')).toBe(live.mapsHref);
    expect(document.querySelector('[data-places-attribution="google"]')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Partner' }).getAttribute('href')).toBe('https://partner.example.com/');
    expect(document.querySelector('[data-mode-chip="simulated"]')).toBeNull();
  });
});

describe('PlacesAttribution', () => {
  it('LIVE: "Google Maps", the returned attributions and the exact terms line with links', () => {
    render(<PlacesAttribution simulated={false} attributions={[{ provider: 'Listings Co', providerUri: null }]} />);
    expect(screen.getByText('Google Maps')).toBeTruthy();
    expect(screen.getByText('Listings Co')).toBeTruthy();
    const terms = document.querySelector('[data-google-terms]')!;
    expect(terms.textContent).toBe(GOOGLE_MAPS_TERMS_LINE);
    expect(within(terms as HTMLElement).getByRole('link', { name: 'Google Maps Additional Terms of Service' }).getAttribute('href')).toBe('https://maps.google.com/help/terms_maps/');
    expect(within(terms as HTMLElement).getByRole('link', { name: 'Google Privacy Policy' }).getAttribute('href')).toBe('https://policies.google.com/privacy');
  });

  it('DEMO: the Simulated chip and no Google attribution', () => {
    render(<PlacesAttribution simulated attributions={[]} />);
    expect(screen.getByText('Simulated')).toBeTruthy();
    expect(screen.queryByText('Google Maps')).toBeNull();
    expect(screen.queryByText(/Results from Google Maps/)).toBeNull();
  });
});
