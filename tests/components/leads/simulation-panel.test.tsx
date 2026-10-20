/**
 * T11 lead console simulation buttons: each source button posts the workspace slug and the chosen
 * record count to /api/demo/simulate/[source] with the session CSRF header and re-reads the page;
 * a refusal is shown with its reference; in LIVE (mode) or without leads.write (permission) the
 * buttons stay focusable, say why, and post nothing.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { CsrfProvider } from '@/components/patterns/csrf';
import { SimulationPanel } from '@/app/dashboard/employee/[ws]/leads/simulation-panel';

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
  vi.useRealTimers();
});

function renderPanel(gate: Parameters<typeof SimulationPanel>[0]['gate'], pending = false) {
  return render(
    <CsrfProvider token="csrf-token-1">
      <SimulationPanel workspaceSlug="smile-avenue-dental" gate={gate} pending={pending} />
    </CsrfProvider>,
  );
}

function card(label: string): HTMLElement {
  return screen.getByText(label).closest('li')!;
}

describe('SimulationPanel', () => {
  it('posts the source, workspace and count with the CSRF header, then refreshes', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ records: 5, events: [{ outcome: 'ACCEPTED' }] }), { status: 200 }));
    renderPanel({ allowed: true });
    fireEvent.change(screen.getByLabelText('Records'), { target: { value: '5' } });
    await act(async () => {
      fireEvent.click(within(card('Meta Lead Ads lead')).getByRole('button', { name: 'Simulate' }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/demo/simulate/meta');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-token-1');
    expect(JSON.parse(init.body as string)).toEqual({ workspaceSlug: 'smile-avenue-dental', count: 5 });
    expect(toast.success).toHaveBeenCalledWith('Meta Lead Ads lead: 5 simulated records received.', expect.anything());
    expect(refresh).toHaveBeenCalled();
  });

  it('shows a refusal with its reference and does not refresh', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'FORBIDDEN', message: 'You do not have permission to do that.', reference: 'req_abc12345' }), { status: 403 }));
    renderPanel({ allowed: true });
    await act(async () => {
      fireEvent.click(within(card('Maps extension batch')).getByRole('button', { name: 'Simulate' }));
    });
    expect(toast.error).toHaveBeenCalledWith('You do not have permission to do that.', { description: 'Reference req_abc12345' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    ['mode', 'Source simulations run only in DEMO mode.'],
    ['permission', 'Your assignment does not include leads.write.'],
  ] as const)('gated by %s: focusable, explained, posts nothing', async (category, reason) => {
    renderPanel({ allowed: false, category, reason });
    for (const label of ['Google Sheets form row', 'Meta Lead Ads lead', 'Maps extension batch']) {
      const button = within(card(label)).getByRole('button', { name: 'Simulate' });
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.getAttribute('data-gate-category')).toBe(category);
      await act(async () => {
        fireEvent.click(button);
      });
    }
    expect(screen.getAllByText(reason)).toHaveLength(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-reads the page every two seconds while an event is still queued', () => {
    vi.useFakeTimers();
    const { rerender } = renderPanel({ allowed: true }, true);
    vi.advanceTimersByTime(4_100);
    expect(refresh).toHaveBeenCalledTimes(2);
    rerender(
      <CsrfProvider token="csrf-token-1">
        <SimulationPanel workspaceSlug="smile-avenue-dental" gate={{ allowed: true }} pending={false} />
      </CsrfProvider>,
    );
    vi.advanceTimersByTime(10_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('a run after the schedule ran out (events still queued) polls again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ records: 1, events: [{ outcome: 'ACCEPTED' }] }), { status: 200 }));
    renderPanel({ allowed: true }, true);
    act(() => vi.advanceTimersByTime(20_000 + 60_000 + 180_000));
    expect(refresh).toHaveBeenCalledTimes(40);
    expect(screen.getByRole('status').textContent).toContain('The worker has not processed the queued events yet.');

    await act(async () => {
      fireEvent.click(within(card('Google Sheets form row')).getByRole('button', { name: 'Simulate' }));
    });
    expect(refresh).toHaveBeenCalledTimes(41);
    expect(screen.getByRole('status').textContent).toContain('The worker is processing queued events.');
    act(() => vi.advanceTimersByTime(2_000));
    expect(refresh).toHaveBeenCalledTimes(42);
  });
});
