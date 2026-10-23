/**
 * ADR-118 (slice F1): the Lead Finder search form posts the keywords and locations (one per line,
 * trimmed, de-duplicated), the results per search, the email opt-in and blacklist, a fresh request
 * key and the session CSRF header, then opens the new run. It says how many searches (and, in LIVE,
 * paid Places requests) a search makes; without finder.run or a Google Places key the button stays
 * focusable, says why and posts nothing.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { CsrfProvider } from '@/components/patterns/csrf';
import { FinderRunForm } from '@/components/finder/FinderRunForm';
import type { Gate } from '@/components/patterns/GatedAction';

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push, replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  push.mockReset();
  refresh.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderForm(gate: Gate | null = null, mode: 'demo' | 'live' = 'demo') {
  return render(
    <CsrfProvider token="csrf-token-1">
      <FinderRunForm workspaceSlug="codecraft-web" mode={mode} gate={gate} />
    </CsrfProvider>,
  );
}

describe('FinderRunForm', () => {
  it('posts the search with the CSRF header and opens the new run', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ run: { id: 'run_1' }, created: true }), { status: 200 }));
    renderForm();
    fireEvent.change(screen.getByLabelText('Keywords, one per line'), { target: { value: 'restaurants\n dental clinic \nRestaurants\n' } });
    fireEvent.change(screen.getByLabelText('Locations, one per line'), { target: { value: 'Indore\nBhopal' } });
    fireEvent.change(screen.getByLabelText('Results per search'), { target: { value: '40' } });
    expect(screen.getByText('4 searches (2 × 2), up to 160 results.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Look for email addresses on each listed website'));
    fireEvent.change(screen.getByLabelText('Never keep these addresses or domains, one per line'), { target: { value: 'gmail.com\n' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start search' }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/app/finder/runs');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-token-1');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ workspaceSlug: 'codecraft-web', keywords: ['restaurants', 'dental clinic'], locations: ['Indore', 'Bhopal'], maxPerQuery: 40, extractEmails: true, emailBlacklist: ['gmail.com'] });
    expect(body.requestKey).toMatch(/^[0-9a-f]{32}$/);
    expect(toast.success).toHaveBeenCalledWith('Search started.', expect.anything());
    expect(push).toHaveBeenCalledWith('/dashboard/employee/codecraft-web/finder?run=run_1');
  });

  it('asks for a keyword and a location instead of posting an empty search', async () => {
    renderForm();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start search' }));
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Add at least one keyword and one location.');
  });

  it('shows a refusal with its reference', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'FINDER_RUN_LIMIT', message: 'This workspace already has 2 searches waiting or running.', reference: 'req_abc12345' }), { status: 409 }));
    renderForm();
    fireEvent.change(screen.getByLabelText('Keywords, one per line'), { target: { value: 'gym' } });
    fireEvent.change(screen.getByLabelText('Locations, one per line'), { target: { value: 'Indore' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start search' }));
    });
    expect(toast.error).toHaveBeenCalledWith('This workspace already has 2 searches waiting or running.', { description: 'Reference: req_abc12345' });
    expect(push).not.toHaveBeenCalled();
  });

  it('LIVE says how many paid Places requests the search may make', () => {
    renderForm(null, 'live');
    fireEvent.change(screen.getByLabelText('Keywords, one per line'), { target: { value: 'gym\nsalon' } });
    fireEvent.change(screen.getByLabelText('Locations, one per line'), { target: { value: 'Indore' } });
    fireEvent.change(screen.getByLabelText('Results per search'), { target: { value: '60' } });
    expect(screen.getByText(/Uses up to 6 paid Google Places requests on your key\./)).toBeTruthy();
  });

  it.each([
    [{ category: 'permission', reason: 'Your assignment here does not include “Run lead finder”. A super admin can grant it.' }],
    [{ category: 'configuration', reason: 'Save a Google Places API key first: searches run on your own key.', fix: { href: '/dashboard/employee/codecraft-web/integrations/google-places', label: 'Set up Google Places' } }],
  ] as const)('gated (%o): focusable, explained, posts nothing', async (gate) => {
    renderForm(gate as Gate);
    fireEvent.change(screen.getByLabelText('Keywords, one per line'), { target: { value: 'gym' } });
    fireEvent.change(screen.getByLabelText('Locations, one per line'), { target: { value: 'Indore' } });
    const button = screen.getByRole('button', { name: 'Start search' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('data-gate-category')).toBe(gate.category);
    expect(screen.getByText(gate.reason, { exact: false })).toBeTruthy();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    if ('fix' in gate) expect(screen.getByRole('link', { name: 'Set up Google Places' }).getAttribute('href')).toBe(gate.fix.href);
  });
});
