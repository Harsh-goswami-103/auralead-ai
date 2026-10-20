/**
 * Quote editor line layout (user report): each line shows a short visible "Quantity" label while
 * its accessible name still names the service ("Quantity of Teeth whitening"), the quantity range
 * uses digit grouping, and "Add" stays a real button whose blocked state (no service chosen) is
 * marked aria-disabled and does nothing.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import type { QuoteEditorCatalogDto } from '@/server/services/quotes/versioning';
import { QuoteEditor } from '@/app/dashboard/user/quotations/quote-editor';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(cleanup);

const catalog: QuoteEditorCatalogDto = {
  activePricingVersion: { id: 'pv_1', version: 1 },
  services: [
    { id: 'svc_whiten', code: 'WHITEN', name: 'Teeth whitening', unitLabel: 'session', unitPricePaise: '850000', minQty: 1, maxQty: 10000, maxDiscountBps: 1000 },
    { id: 'svc_rct', code: 'RCT', name: 'Root canal treatment', unitLabel: 'tooth', unitPricePaise: '650000', minQty: 1, maxQty: 8, maxDiscountBps: 500 },
  ],
  settings: { maxDiscountBps: 1500, quoteValidityDays: 15, taxMode: 'NONE', taxLabel: null, taxBps: null },
  actorMaxDiscountBps: null,
};

describe('QuoteEditor lines', () => {
  it('shows a short quantity label with the full accessible name and a grouped range', () => {
    render(
      <CsrfProvider token="csrf">
        <QuoteEditor
          catalog={catalog}
          mode={{ kind: 'create', leadId: 'lead_1', draftId: null }}
          initial={{ items: [{ serviceId: 'svc_whiten', qty: 2 }], discountKind: 'NONE', discountValue: '0', scopeText: 'Whitening', timelineText: 'A week', validityDays: null }}
          gate={null}
          submitLabel="Save quote"
        />
      </CsrfProvider>,
    );
    const qty = screen.getByLabelText('Quantity of Teeth whitening') as HTMLInputElement;
    expect(qty.value).toBe('2');
    const label = document.querySelector(`label[for="${qty.id}"]`)!;
    expect(label.textContent).toBe('Quantity of Teeth whitening');
    expect(label.querySelector('.sr-only')?.textContent).toBe(' of Teeth whitening');
    expect(screen.getByText(/1 to 10,000/)).toBeTruthy();

    const add = screen.getByRole('button', { name: 'Add' });
    expect(add.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(add);
    expect(screen.queryByLabelText('Quantity of Root canal treatment')).toBeNull();
  });
});
