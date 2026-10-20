/**
 * Pricing wording and layout fixes (user report): a one-day timeline reads "1 day" (not "1 days"),
 * quantity ranges use Indian digit grouping on both ends, an unpriced service says so with its words
 * (not color alone), the Services list stays a real table row, and the tab strip keeps exactly the
 * five tab names with one selected.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import type { PricingOverviewDto } from '@/server/services/pricing/catalog';
import { PricingWorkspace } from '@/app/dashboard/user/pricing/pricing-workspace';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(cleanup);

const overview: PricingOverviewDto = {
  workspace: { name: 'Alpha Dental', timezone: 'Asia/Kolkata' },
  canEdit: true,
  activeVersion: { id: 'pv_1', version: 1, note: 'Initial price list', createdAt: '2026-10-15T10:00:00.000Z' },
  services: [
    {
      id: 'svc_consult',
      code: 'CONSULT',
      name: 'Dental consultation',
      description: '',
      unitLabel: 'visit',
      defaultTimelineDays: 1,
      maxDiscountBps: null,
      archivedAt: null,
      price: { unitPricePaise: '80000', minQty: 1, maxQty: 10000 },
    },
    {
      id: 'svc_new',
      code: 'NEW',
      name: 'Night guard',
      description: '',
      unitLabel: 'piece',
      defaultTimelineDays: 7,
      maxDiscountBps: 500,
      archivedAt: null,
      price: null,
    },
  ],
  settings: { taxMode: 'NONE', taxLabel: null, taxBps: null, maxDiscountBps: 1500, quoteValidityDays: 1, gstin: null, updatedAt: '2026-10-15T09:00:00.000Z' },
  versions: [],
};

function renderPage() {
  render(
    <CsrfProvider token="csrf">
      <PricingWorkspace overview={overview} />
    </CsrfProvider>,
  );
}

function selectTab(name: string) {
  const tab = screen.getByRole('tab', { name });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
}

describe('PricingWorkspace wording', () => {
  it('keeps the five tabs and formats the services rows', () => {
    renderPage();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Services', 'Tax', 'Discounts', 'Timelines', 'History']);
    expect(screen.getByRole('tab', { name: 'Services' }).getAttribute('aria-selected')).toBe('true');
    const row = screen.getByText('Dental consultation').closest('tr')!;
    expect(row.textContent).toContain('1 to 10,000');
    expect(row.textContent).toContain('Workspace limit');
    const unpriced = screen.getByText('Night guard').closest('tr')!;
    expect(unpriced.textContent).toContain('Not priced: quotes need review');
    expect(unpriced.querySelector('svg')).not.toBeNull();
  });

  it('says "1 day" for a one-day timeline', () => {
    renderPage();
    selectTab('Timelines');
    expect(screen.getByText('1 day')).toBeTruthy();
    expect(screen.getByText('7 days')).toBeTruthy();
    expect(screen.queryByText(/\b1 days\b/)).toBeNull();
  });
});
