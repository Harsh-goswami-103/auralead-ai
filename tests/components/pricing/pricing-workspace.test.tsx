/**
 * T13 Pricing page body: the forms are real. Adding a service converts typed rupees to paise and
 * posts to /api/app/pricing/services with the CSRF header and the price list version on screen;
 * a server refusal is shown with its reference; editing sends only changed fields; tax requires
 * an explicit choice and posts to the settings route; a member sees the data read-only with the
 * controls gated by permission.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import type { PricingOverviewDto } from '@/server/services/pricing/catalog';
import { PricingWorkspace } from '@/app/dashboard/user/pricing/pricing-workspace';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function overview(canEdit: boolean): PricingOverviewDto {
  return {
    workspace: { name: 'Alpha Dental', timezone: 'Asia/Kolkata' },
    canEdit,
    activeVersion: { id: 'pv_3', version: 3, note: 'Changed WHITEN', createdAt: '2026-10-15T10:00:00.000Z' },
    services: [
      {
        id: 'svc_whiten',
        code: 'WHITEN',
        name: 'Teeth whitening',
        description: 'In-clinic whitening session.',
        unitLabel: 'session',
        defaultTimelineDays: 7,
        maxDiscountBps: 1000,
        archivedAt: null,
        price: { unitPricePaise: '1200000', minQty: 1, maxQty: 4 },
      },
    ],
    settings: { taxMode: 'NONE', taxLabel: null, taxBps: null, maxDiscountBps: 1500, quoteValidityDays: 15, gstin: null, updatedAt: '2026-10-15T09:00:00.000Z' },
    versions: [
      {
        id: 'pv_3',
        version: 3,
        active: true,
        note: 'Changed WHITEN',
        createdAt: '2026-10-15T10:00:00.000Z',
        createdByName: 'Owner',
        entries: [{ serviceId: 'svc_whiten', code: 'WHITEN', name: 'Teeth whitening', unitLabel: 'session', unitPricePaise: '1200000', minQty: 1, maxQty: 4 }],
      },
    ],
  };
}

function renderPage(canEdit = true) {
  render(
    <CsrfProvider token="csrf-token-123">
      <PricingWorkspace overview={overview(canEdit)} />
    </CsrfProvider>,
  );
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) as Record<string, unknown>, headers: init.headers as Record<string, string> };
}

function selectTab(name: string) {
  const tab = screen.getByRole('tab', { name });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
}

describe('PricingWorkspace', () => {
  it('lists services with formatted INR prices from the active version', () => {
    renderPage();
    const row = screen.getByText('Teeth whitening').closest('tr')!;
    expect(row.textContent).toContain('₹12,000.00');
    expect(row.textContent).toContain('/ session');
    expect(row.textContent).toContain('10%');
  });

  it('adding a service posts paise and the expected version with the CSRF header, then refreshes', async () => {
    fetchMock.mockResolvedValue(ok({ service: { id: 'svc_new' }, pricingVersion: { id: 'pv_4', version: 4 } }));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Add service' }));
    const dialog = screen.getByRole('dialog');
    const field = (label: string) => within(dialog).getByLabelText(label);
    fireEvent.change(field('Code'), { target: { value: 'seo-basic' } });
    fireEvent.change(field('Name'), { target: { value: 'SEO basics' } });
    fireEvent.change(field('Unit price'), { target: { value: '12,500.50' } });
    fireEvent.change(field('Per'), { target: { value: 'month' } });
    fireEvent.change(field('Discount limit'), { target: { value: '12.5' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Add service' }));
    });
    const { url, body, headers } = lastCall();
    expect(url).toBe('/api/app/pricing/services');
    expect(headers['x-csrf-token']).toBe('csrf-token-123');
    expect(body).toMatchObject({ code: 'SEO-BASIC', name: 'SEO basics', unitLabel: 'month', unitPricePaise: '1250050', minQty: 1, maxQty: 10000, maxDiscountBps: 1250, defaultTimelineDays: null, expectedVersion: 3 });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('invalid input is caught on the field before any request', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Add service' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Unit price'), { target: { value: '12.345' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Add service' }));
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(within(dialog).getByLabelText('Unit price').getAttribute('aria-invalid')).toBe('true');
    expect(within(dialog).getByRole('alert').textContent).toContain('Fix the highlighted fields.');
  });

  it('a server refusal stays in the dialog with the message and reference', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'PRICING_VERSION_CONFLICT', message: 'The price list changed (now version 4). Reload and try again.', reference: 'req_conflict01' }), { status: 409 }));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Teeth whitening' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Unit price'), { target: { value: '13000' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    });
    const { url, body } = lastCall();
    expect(url).toBe('/api/app/pricing/services/svc_whiten');
    expect(body).toEqual({ unitPricePaise: '1300000', expectedVersion: 3 });
    expect(within(dialog).getByRole('alert').textContent).toContain('The price list changed (now version 4)');
    expect(within(dialog).getByRole('alert').textContent).toContain('req_conflict01');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('tax: choosing one configured line posts label, rate in bps and GSTIN', async () => {
    fetchMock.mockResolvedValue(ok({ settings: {} }));
    renderPage();
    selectTab('Tax');
    fireEvent.click(screen.getByRole('radio', { name: /Add one tax line/ }));
    fireEvent.change(screen.getByLabelText('Rate'), { target: { value: '18' } });
    fireEvent.change(screen.getByLabelText('GSTIN'), { target: { value: '07aaacr5055k1z5' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save tax settings' }));
    });
    const { url, body } = lastCall();
    expect(url).toBe('/api/app/pricing/settings');
    expect(body).toEqual({ taxMode: 'CONFIGURED', taxLabel: 'GST', taxBps: 1800, gstin: '07AAACR5055K1Z5' });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a member sees pricing read-only with the controls gated by permission', async () => {
    renderPage(false);
    const add = screen.getByRole('link', { name: 'Add service' });
    expect(add.getAttribute('aria-disabled')).toBe('true');
    expect(add.getAttribute('data-gate-category')).toBe('permission');
    expect(screen.queryByRole('button', { name: 'Edit Teeth whitening' })).toBeNull();
    selectTab('Discounts');
    const save = screen.getByRole('button', { name: 'Save discount limit' });
    expect(save.getAttribute('aria-disabled')).toBe('true');
    await act(async () => {
      fireEvent.click(save);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('history lists each version with its prices', () => {
    renderPage();
    selectTab('History');
    expect(screen.getByText('v3')).toBeTruthy();
    expect(screen.getByText('Changed WHITEN', { selector: 'span' })).toBeTruthy();
  });
});
