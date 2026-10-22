/**
 * ADR-118 (slice F1): the recent runs. Each shows its terms, status as icon + label, a progress bar
 * over its searches (accessible values), the places found and the Simulated chip for DEMO runs; the
 * page is re-read while a run waits or searches; Cancel posts with the CSRF header (or says why it
 * is not offered).
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { CsrfProvider } from '@/components/patterns/csrf';
import { FinderRunsList } from '@/components/finder/FinderRunsList';
import type { Gate } from '@/components/patterns/GatedAction';
import type { FinderRunDto } from '@/server/services/lead-finder/runs';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function run(over: Partial<FinderRunDto>): FinderRunDto {
  return {
    id: 'run_1',
    status: 'RUNNING',
    keywords: ['restaurants', 'dental clinic'],
    locations: ['Indore'],
    maxPerQuery: 20,
    extractEmails: false,
    blacklistCount: 0,
    cellsTotal: 2,
    cellsDone: 1,
    resultsFound: 20,
    emailsFound: 0,
    simulated: true,
    errorCode: null,
    createdAt: '2026-10-23T06:00:00.000Z',
    startedAt: '2026-10-23T06:00:01.000Z',
    finishedAt: null,
    cancelledAt: null,
    requestedByViewer: true,
    ...over,
  };
}

function renderList(runs: FinderRunDto[], cancelGate: Gate | null = null) {
  return render(
    <CsrfProvider token="csrf-token-1">
      <FinderRunsList runs={runs} selectedId="run_1" workspaceSlug="codecraft-web" timeZone="Asia/Kolkata" cancelGate={cancelGate} />
    </CsrfProvider>,
  );
}

describe('FinderRunsList', () => {
  it('shows status as icon + label, progress with accessible values and the Simulated chip', () => {
    renderList([run({}), run({ id: 'run_2', status: 'PARTIAL', cellsDone: 2, simulated: false, errorCode: 'PLACES_RATE_LIMITED' })]);
    const first = document.querySelector('[data-run-id="run_1"]') as HTMLElement;
    expect(within(first).getByText('Searching')).toBeTruthy();
    const bar = within(first).getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('1');
    expect(bar.getAttribute('aria-valuemax')).toBe('2');
    expect(bar.getAttribute('aria-valuetext')).toBe('1 of 2 searches done');
    expect(within(first).getByText(/20 places/)).toBeTruthy();
    expect(first.querySelector('[data-mode-chip="simulated"]')).not.toBeNull();
    expect(within(first).getByRole('link', { name: /restaurants, dental clinic/ }).getAttribute('aria-current')).toBe('true');
    const second = document.querySelector('[data-run-id="run_2"]') as HTMLElement;
    expect(within(second).getByText('Finished with gaps')).toBeTruthy();
    expect(within(second).getByText(/quota for this key was exhausted/)).toBeTruthy();
    expect(second.querySelector('[data-mode-chip]')).toBeNull();
    expect(within(second).queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('re-reads the page while a run is active', () => {
    vi.useFakeTimers();
    renderList([run({})]);
    act(() => {
      vi.advanceTimersByTime(2_100);
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('does not poll when every run has finished', () => {
    vi.useFakeTimers();
    renderList([run({ status: 'SUCCEEDED', cellsDone: 2 })]);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('cancels with one POST, or says why it cannot', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ cancelled: true }), { status: 200 }));
    renderList([run({})]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/app/finder/runs/run_1/cancel');
    expect(JSON.parse(init.body as string)).toEqual({ workspaceSlug: 'codecraft-web' });
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-token-1');
    expect(toast.success).toHaveBeenCalledWith('Search cancelled.', expect.anything());
    cleanup();
    renderList([run({})], { category: 'permission', reason: 'Your assignment here does not include “Run lead finder”.' });
    expect(screen.getByRole('button', { name: 'Cancel' }).getAttribute('aria-disabled')).toBe('true');
  });
});
