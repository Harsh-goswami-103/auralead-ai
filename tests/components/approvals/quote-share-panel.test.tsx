/**
 * T22 quotation share controls (P15, 06-design §11.2 "User Quotations", §11.3 "Quote share"):
 * create a link (expiry within the quote's validity), copy it (an APPROVED quote is marked sent with
 * MANUAL_LINK only after the copy succeeded), mark as sent manually, revoke a link, and the view
 * evidence wording ("Opens do not confirm a person read it"). Without `dispatch.send` the controls
 * are gated by permission.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import { QuoteSharePanel, type QuoteSharePanelProps } from '@/components/approvals/QuoteSharePanel';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fetchMock = vi.fn();
const writeText = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  writeText.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const base: QuoteSharePanelProps = {
  quoteId: 'q1',
  number: 'Q-0004',
  versionNo: 1,
  status: 'APPROVED',
  sentVia: null,
  timeZone: 'Asia/Kolkata',
  shares: [],
  evidence: { opens: 0, lastOpenAt: null, fetches: 0, openedWhileUnsent: false },
  canShare: true,
};

function renderPanel(props: Partial<QuoteSharePanelProps> = {}) {
  render(
    <CsrfProvider token="csrf-share">
      <QuoteSharePanel {...base} {...props} />
    </CsrfProvider>,
  );
}

const calls = () => fetchMock.mock.calls.map(([url, init]) => ({ url: url as string, body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown> }));

describe('QuoteSharePanel', () => {
  it('create link, then Copy link copies it and marks the APPROVED quote sent (COPY_LINK)', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { share: { id: 's1', state: 'ACTIVE', expiresAt: '2026-10-31T00:00:00.000Z' }, url: 'http://localhost:3000/quote/tok123' }))
      .mockResolvedValueOnce(json(200, { quote: { status: 'SENT', sentVia: 'MANUAL_LINK' }, changed: true }));
    writeText.mockResolvedValue(undefined);
    renderPanel();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create share link' })));
    expect(calls()[0]).toEqual({ url: '/api/app/quotes/q1/shares', body: {} });
    expect((screen.getByLabelText('Share link') as HTMLInputElement).value).toBe('http://localhost:3000/quote/tok123');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy link' })));
    expect(writeText).toHaveBeenCalledWith('http://localhost:3000/quote/tok123');
    expect(calls()[1]).toEqual({ url: '/api/app/quotes/q1/mark-sent', body: { expectedVersion: 1, via: 'COPY_LINK' } });
    expect(screen.getByRole('status').textContent).toContain('marked as sent');
  });

  it('a failed copy does not mark the quote sent and says how to proceed', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { share: { id: 's1', state: 'ACTIVE', expiresAt: '2026-10-31T00:00:00.000Z' }, url: 'http://localhost:3000/quote/tok123' }));
    writeText.mockRejectedValue(new Error('denied'));
    renderPanel();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create share link' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy link' })));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').textContent).toContain('could not copy');
  });

  it('a chosen expiry is sent in days', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { share: { id: 's1', state: 'ACTIVE', expiresAt: '2026-10-23T00:00:00.000Z' }, url: 'http://localhost:3000/quote/tok' }));
    renderPanel();
    fireEvent.change(screen.getByLabelText('Link expires'), { target: { value: '7' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create share link' })));
    expect(calls()[0]!.body).toEqual({ expiresInDays: 7 });
  });

  it('mark as sent manually and revoke run through confirmation', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { quote: { status: 'SENT' }, changed: true })).mockResolvedValueOnce(json(200, { share: { id: 's9', state: 'REVOKED' }, changed: true }));
    renderPanel({ shares: [{ id: 's9', state: 'ACTIVE', expiresAt: '2026-10-31T00:00:00.000Z', createdAt: '2026-10-16T06:00:00.000Z' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Mark as sent manually' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Mark as sent' })));
    expect(calls()[0]).toEqual({ url: '/api/app/quotes/q1/mark-sent', body: { expectedVersion: 1, via: 'MARK_SENT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Revoke link' })));
    expect(calls()[1]).toEqual({ url: '/api/app/quotes/q1/shares/s9/revoke', body: {} });
  });

  it('view evidence never claims a person read it', () => {
    renderPanel({ status: 'SENT', sentVia: 'MANUAL_LINK', evidence: { opens: 2, lastOpenAt: '2026-10-16T08:40:00.000Z', fetches: 3, openedWhileUnsent: false } });
    expect(screen.getByText(/Link opened 2x, last 14:10 IST\. Opens do not confirm a person read it\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark as sent manually' })).toBeNull();
    expect(screen.getByText(/Sent manually \(link or PDF\)/)).toBeTruthy();
  });

  it('without dispatch.send the controls are gated by permission', async () => {
    renderPanel({ canShare: false });
    const create = screen.getByRole('button', { name: 'Create share link' });
    expect(create.getAttribute('data-gate-category')).toBe('permission');
    await act(async () => fireEvent.click(create));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
