/**
 * ADR-118 (d) (slice F1, P1): "Confirm details" on a lead imported from Google Places. It says when
 * the Places-sourced fields are removed, posts the confirmation once with the CSRF header and
 * refreshes; a confirmed lead shows when and how; a lead without Places details shows nothing;
 * without leads.write the button stays focusable and says why.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { CsrfProvider } from '@/components/patterns/csrf';
import { ConfirmContactButton } from '@/components/finder/ConfirmContactButton';

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
});

const base = { leadId: 'lead_1', workspaceSlug: 'codecraft-web', placesContentExpiresAt: '2026-11-22T06:00:00.000Z', contactConfirmedAt: null, contactConfirmedVia: null, timeZone: 'Asia/Kolkata', gate: null };

describe('ConfirmContactButton', () => {
  it('says when the Places details go and confirms them with one POST', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ leadId: 'lead_1', confirmed: true }), { status: 200 }));
    render(
      <CsrfProvider token="csrf-token-1">
        <ConfirmContactButton {...base} />
      </CsrfProvider>,
    );
    expect(screen.getByText(/came from Google Places and are removed on 22 Nov 2026 unless the business confirms them/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm details' }));
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/app/leads/lead_1/confirm-contact');
    expect(JSON.parse(init.body as string)).toEqual({ workspaceSlug: 'codecraft-web' });
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-token-1');
    expect(toast.success).toHaveBeenCalledWith('Contact details confirmed.', expect.anything());
    expect(refresh).toHaveBeenCalled();
  });

  it('a confirmed lead shows when and how; a lead without Places details shows nothing', () => {
    const { container, rerender } = render(<ConfirmContactButton {...base} contactConfirmedAt="2026-10-24T06:00:00.000Z" contactConfirmedVia="OPERATOR" />);
    expect(container.textContent).toContain('Contact details confirmed on 24 Oct 2026: Confirmed by an operator.');
    rerender(<ConfirmContactButton {...base} placesContentExpiresAt={null} />);
    expect(container.textContent).toBe('');
  });

  it('without leads.write the button says why and posts nothing', async () => {
    render(<ConfirmContactButton {...base} gate={{ category: 'permission', reason: 'Your assignment here does not include “Edit leads”.' }} />);
    const button = screen.getByRole('button', { name: 'Confirm details' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
