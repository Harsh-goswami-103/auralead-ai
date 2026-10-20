/**
 * Lead detail AutoRefresh (employee report: a failed PDF job made a background tab re-render the
 * page every 2 s forever): it re-reads the page every 2 s at first, then backs off (5 s, then
 * 10 s), skips while the tab is hidden, and after the schedule says the worker is late instead of
 * polling on. Inactive, it renders nothing and never refreshes.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoRefresh } from '@/app/dashboard/employee/[ws]/leads/[leadId]/lead-actions';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  refresh.mockReset();
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AutoRefresh', () => {
  it('polls every 2 s, then backs off to 5 s and 10 s', () => {
    render(<AutoRefresh active label="The worker is still processing this lead; this page updates by itself." />);
    expect(screen.getByRole('status').textContent).toContain('The worker is still processing this lead');
    act(() => vi.advanceTimersByTime(20_000));
    expect(refresh).toHaveBeenCalledTimes(10);
    act(() => vi.advanceTimersByTime(4_900));
    expect(refresh).toHaveBeenCalledTimes(10);
    act(() => vi.advanceTimersByTime(100));
    expect(refresh).toHaveBeenCalledTimes(11);
    act(() => vi.advanceTimersByTime(55_000));
    expect(refresh).toHaveBeenCalledTimes(22);
    act(() => vi.advanceTimersByTime(10_000));
    expect(refresh).toHaveBeenCalledTimes(23);
  });

  it('skips refreshes while the tab is hidden', () => {
    render(<AutoRefresh active label="Working." />);
    visibility = 'hidden';
    act(() => vi.advanceTimersByTime(10_000));
    expect(refresh).not.toHaveBeenCalled();
    visibility = 'visible';
    act(() => vi.advanceTimersByTime(2_000));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('stops after the schedule and says the worker is late', () => {
    render(<AutoRefresh active label="Working." />);
    act(() => vi.advanceTimersByTime(20_000 + 60_000 + 180_000));
    expect(refresh).toHaveBeenCalledTimes(40);
    act(() => vi.advanceTimersByTime(600_000));
    expect(refresh).toHaveBeenCalledTimes(40);
    expect(screen.getByRole('status').textContent).toContain('Still waiting for the worker');
  });

  it('inactive: renders nothing and never refreshes', () => {
    const { container } = render(<AutoRefresh active={false} label="Working." />);
    act(() => vi.advanceTimersByTime(30_000));
    expect(refresh).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });
});
