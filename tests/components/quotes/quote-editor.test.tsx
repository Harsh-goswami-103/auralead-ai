/**
 * T15 quote editor: the form is real. New-from-proposal starts with the proposal's services and
 * posts service ids, quantities and a discount in basis points (never a price) with the CSRF
 * header, then opens the created quote; a server refusal is shown with its reference; a revision
 * posts the version on screen and offers re-pricing only when a newer price list exists; without
 * the capability the action is gated by permission and nothing is sent.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import type { QuoteEditorCatalogDto } from '@/server/services/quotes/versioning';
import { QuoteEditor, type EditorInitial, type EditorMode } from '@/app/dashboard/user/quotations/quote-editor';

const refresh = vi.fn();
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push, replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  push.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const catalog: QuoteEditorCatalogDto = {
  activePricingVersion: { id: 'pv_2', version: 2 },
  services: [
    { id: 'svc_whiten', code: 'WHITEN', name: 'Teeth whitening', unitLabel: 'session', unitPricePaise: '850000', minQty: 1, maxQty: 4, maxDiscountBps: 1000 },
    { id: 'svc_rct', code: 'RCT', name: 'Root canal treatment', unitLabel: 'tooth', unitPricePaise: '650000', minQty: 1, maxQty: 8, maxDiscountBps: 500 },
  ],
  settings: { maxDiscountBps: 1500, quoteValidityDays: 15, taxMode: 'CONFIGURED', taxLabel: 'GST', taxBps: 1800 },
  actorMaxDiscountBps: null,
};

const proposal: EditorInitial = { items: [{ serviceId: 'svc_whiten', qty: 2 }], discountKind: 'NONE', discountValue: '0', scopeText: 'Whitening course', timelineText: 'Two weeks', validityDays: null };

function renderEditor(mode: EditorMode, initial: EditorInitial = proposal, gate: Parameters<typeof QuoteEditor>[0]['gate'] = null) {
  render(
    <CsrfProvider token="csrf-quotes">
      <QuoteEditor catalog={catalog} mode={mode} initial={initial} gate={gate} submitLabel="Save quote" />
    </CsrfProvider>,
  );
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) as Record<string, unknown>, headers: init.headers as Record<string, string> };
}
async function save() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save quote' }));
  });
}

describe('QuoteEditor', () => {
  it('new from proposal posts ids, quantities and a basis-point discount, then opens the quote', async () => {
    fetchMock.mockResolvedValue(ok({ quote: { id: 'q_1', number: 'Q-0007' } }));
    renderEditor({ kind: 'create', leadId: 'lead_1', draftId: 'draft_1' });
    expect(screen.getByText('Teeth whitening')).toBeTruthy();
    expect(screen.getByText(/List price before discount and tax: ₹17,000.00/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Add a service'), { target: { value: 'svc_rct' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.change(screen.getByLabelText('Quantity of Root canal treatment'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Discount'), { target: { value: 'PERCENT_BPS' } });
    expect(screen.getByText(/Limit for these services: 5%/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Discount (%)'), { target: { value: '4.5' } });
    await save();

    const { url, body, headers } = lastCall();
    expect(url).toBe('/api/app/quotes');
    expect(headers['x-csrf-token']).toBe('csrf-quotes');
    expect(body).toEqual({
      leadId: 'lead_1',
      draftId: 'draft_1',
      items: [
        { serviceId: 'svc_whiten', qty: 2 },
        { serviceId: 'svc_rct', qty: 3 },
      ],
      discount: { kind: 'PERCENT_BPS', value: '450' },
      scopeText: 'Whitening course',
      timelineText: 'Two weeks',
      validityDays: 15,
    });
    expect(JSON.stringify(body)).not.toMatch(/price/i);
    expect(push).toHaveBeenCalledWith('/dashboard/user/quotations/q_1');
  });

  it('checks fields before sending and shows a server refusal with its reference', async () => {
    renderEditor({ kind: 'create', leadId: 'lead_1', draftId: null }, { ...proposal, scopeText: '' });
    await save();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Scope of work').getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(screen.getByLabelText('Scope of work'), { target: { value: 'Whitening' } });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'DISCOUNT_OVER_LIMIT', message: 'The discount is above the 5% limit for this quote.', reference: 'req_quote_1' }), { status: 422 }));
    await save();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('above the 5% limit');
    expect(alert.textContent).toContain('req_quote_1');
    expect(push).not.toHaveBeenCalled();
  });

  it('a revision posts the version on screen and can re-price against a newer price list', async () => {
    fetchMock.mockResolvedValue(ok({ version: { versionNo: 3 } }));
    renderEditor({ kind: 'revise', quoteId: 'q_9', expectedVersion: 2, pricingVersionId: 'pv_1', pricingVersionNo: 1 }, { ...proposal, discountKind: 'FLAT_PAISE', discountValue: '150000' });
    expect((screen.getByLabelText('Discount (₹)') as HTMLInputElement).value).toBe('1500.00');
    fireEvent.click(screen.getByRole('checkbox', { name: /Use the current price list \(v2\)/ }));
    await save();
    const { url, body } = lastCall();
    expect(url).toBe('/api/app/quotes/q_9/revise');
    expect(body).toMatchObject({ expectedVersion: 2, repriceToActive: true, discount: { kind: 'FLAT_PAISE', value: '150000' } });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('without the capability the action is gated by permission and sends nothing', async () => {
    renderEditor({ kind: 'create', leadId: 'lead_1', draftId: null }, proposal, { category: 'permission', reason: 'Your role cannot create quotations in this workspace.' });
    const button = screen.getByRole('button', { name: 'Save quote' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('data-gate-category')).toBe('permission');
    await save();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(within(document.body).getByText('Your role cannot create quotations in this workspace.')).toBeTruthy();
  });
});
