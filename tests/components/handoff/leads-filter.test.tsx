/**
 * Lead-gen F5 (ADR-124): the Leads toolbar's "Handoff" filter. It shows the URL's state, a change
 * navigates to `?handedOver=1` at once (a select navigates in place), and "Clear filters" appears
 * while it is on.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeadsToolbar } from '@/components/leads/LeadsToolbar';
import { parseLeadPageParams } from '@/lib/schemas/leads';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }) }));

afterEach(() => {
  cleanup();
  push.mockReset();
});

describe('LeadsToolbar handoff filter', () => {
  it('selecting "Handed over to the client" navigates to ?handedOver=1', () => {
    render(<LeadsToolbar basePath="/dashboard/user/leads" params={parseLeadPageParams({})} />);
    const select = screen.getByLabelText('Handoff') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect([...select.options].map((o) => o.textContent)).toEqual(['All leads', 'Handed over to the client']);
    fireEvent.change(select, { target: { value: '1' } });
    expect(push).toHaveBeenCalledWith('/dashboard/user/leads?handedOver=1', { scroll: false });
    expect(screen.queryByRole('link', { name: 'Clear filters' })).toBeNull();
  });

  it('shows the filter from the URL with "Clear filters"', () => {
    render(<LeadsToolbar basePath="/dashboard/user/leads" params={parseLeadPageParams({ handedOver: '1', stage: 'CONVERTED' })} />);
    expect((screen.getByLabelText('Handoff') as HTMLSelectElement).value).toBe('1');
    expect(screen.getByRole('link', { name: 'Clear filters' }).getAttribute('href')).toBe('/dashboard/user/leads');
  });
});
