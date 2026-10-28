/**
 * ADR-118 (b), (d), adversarial review: the notice on a lead that came from Places. LIVE names
 * "Google Maps", the attributions Google returned and the terms line; DEMO says the listing is
 * simulated and shows no Google attribution; without leads.write "Confirm details" is gated with its
 * reason (never an enabled button); a lead that did not come from Places shows nothing.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeadPlacesNotice } from '@/components/leads/LeadPlacesNotice';
import { CsrfProvider } from '@/components/patterns/csrf';
import type { LeadProfileDto } from '@/lib/schemas/leads';
import { GOOGLE_MAPS_TERMS_LINE } from '@/server/services/lead-finder/schemas';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(cleanup);

type Places = NonNullable<LeadProfileDto['places']>;
const places = (over: Partial<Places> = {}): Places => ({
  expiresAt: '2026-11-22T06:00:00.000Z',
  confirmedAt: null,
  confirmedVia: null,
  attributions: [{ provider: 'Fixture Listings Partner', providerUri: 'https://partner.example.com/' }],
  canConfirm: true,
  ...over,
});
const view = (p: LeadProfileDto['places'], simulated: boolean) =>
  render(
    <CsrfProvider token="t">
      <LeadPlacesNotice leadId="lead_1" places={p} simulated={simulated} timeZone="Asia/Kolkata" workspaceSlug="codecraft-web" />
    </CsrfProvider>,
  );

describe('LeadPlacesNotice', () => {
  it('LIVE: Google Maps, the partner attribution link and the terms line', () => {
    view(places(), false);
    expect(screen.getByText('Google Maps')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Fixture Listings Partner' }).getAttribute('href')).toBe('https://partner.example.com/');
    expect(document.querySelector('[data-google-terms]')?.textContent).toBe(GOOGLE_MAPS_TERMS_LINE);
    expect(document.querySelector('[data-places-attribution="simulated"]')).toBeNull();
  });

  it('DEMO: the simulated note and no Google attribution', () => {
    view(places({ attributions: [] }), true);
    expect(document.querySelector('[data-places-attribution="simulated"]')).not.toBeNull();
    expect(document.querySelector('[data-places-attribution="google"]')).toBeNull();
    expect(screen.queryByText(/Results from Google Maps/)).toBeNull();
  });

  it('without leads.write Confirm details is gated with its reason, not an enabled button', () => {
    view(places({ canConfirm: false }), false);
    const button = screen.getByRole('button', { name: 'Confirm details' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/needs leads\.write/)).toBeTruthy();
  });

  it('with leads.write the button is live; a lead that did not come from Places shows nothing', () => {
    view(places(), false);
    expect(screen.getByRole('button', { name: 'Confirm details' }).getAttribute('aria-disabled')).toBeNull();
    cleanup();
    const { container } = view(null, false);
    expect(container.querySelector('[data-lead-places]')).toBeNull();
  });
});
