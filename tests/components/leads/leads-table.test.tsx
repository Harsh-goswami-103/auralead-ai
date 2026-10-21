/**
 * T26, R31: the Leads table (TanStack Table v8) lays out the page the server sent. Rows show the
 * lead link first (the sheet or the lead page), the stage as icon + label, the score beside its
 * meter or "Not scored", source, contact and city; sortable headers are buttons with aria-sort that
 * navigate to the server's sort; paging is keyset links with the capped total ("1,000+"); the
 * "Move to stage" menu appears only for a viewer who may move leads. The toolbar is a GET form whose
 * selects navigate in place, and a new filter starts at the first page.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeadsTable, type LeadsTableProps } from '@/components/leads/LeadsTable';
import { LeadsToolbar } from '@/components/leads/LeadsToolbar';
import type { LeadRowDto } from '@/components/leads/types';
import { CsrfProvider } from '@/components/patterns/csrf';
import { parseLeadPageParams } from '@/lib/schemas/leads';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push, replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  push.mockReset();
});

const rows: LeadRowDto[] = [
  {
    id: 'l1',
    displayName: 'राहुल शर्मा',
    city: 'Noida',
    category: 'Dental clinic',
    phoneE164: '+919876543210',
    emailNormalized: null,
    firstSource: 'META_ADS',
    salesStage: 'REPLIED',
    stageVersion: 2,
    score: 72,
    simulated: true,
    createdAt: '2026-10-16T06:00:00.000Z',
    href: '/dashboard/user/leads?lead=l1',
  },
  {
    id: 'l2',
    displayName: 'Asha Raman',
    city: null,
    category: null,
    phoneE164: null,
    emailNormalized: 'asha@example.test',
    firstSource: 'GMAPS_EXTENSION',
    salesStage: 'NEW',
    stageVersion: 0,
    score: null,
    simulated: false,
    createdAt: '2026-10-15T06:00:00.000Z',
    href: '/dashboard/user/leads?lead=l2',
  },
];

const sortHrefs = { newest: '/l', oldest: '/l?sort=oldest', score: '/l?sort=score', name: '/l?sort=name' };

function renderTable(overrides: Partial<LeadsTableProps> = {}) {
  return render(
    <CsrfProvider token="csrf-table">
      <LeadsTable
        rows={rows}
        total={{ count: 51, capped: false }}
        sort="newest"
        timeZone="Asia/Kolkata"
        sortHrefs={sortHrefs}
        prevHref={null}
        nextHref="/l?cursor=abc"
        firstHref={null}
        canMove
        caption="Leads, newest first"
        {...overrides}
      />
    </CsrfProvider>,
  );
}

describe('LeadsTable', () => {
  it('renders the server page: lead link first, stage chip, score or "Not scored", source, contact, city', () => {
    renderTable();
    const table = screen.getByRole('table', { name: 'Leads, newest first' });
    const [first, second] = within(table).getAllByRole('row').slice(1);
    const firstLink = within(first!).getAllByRole('link')[0]!;
    expect(firstLink.textContent).toBe('राहुल शर्मा');
    expect(firstLink.getAttribute('href')).toBe('/dashboard/user/leads?lead=l1');
    expect(within(table).getAllByRole('link')[0]).toBe(firstLink);
    expect(first!.querySelector('[data-sales-stage="REPLIED"]')?.textContent).toBe('Replied');
    expect(within(first!).getByText('72 / 100')).toBeTruthy();
    expect(within(first!).getByText('Simulated')).toBeTruthy();
    expect(within(first!).getByText('+919876543210')).toBeTruthy();
    expect(within(second!).getByText('Not scored')).toBeTruthy();
    expect(within(second!).getByText('asha@example.test')).toBeTruthy();
    expect(within(second!).getByText('Unknown')).toBeTruthy();
    expect(within(first!).getByRole('button', { name: 'Move to stage: राहुल शर्मा' })).toBeTruthy();
  });

  it('sortable headers are buttons with aria-sort that ask the server for the order', () => {
    renderTable();
    const added = screen.getByRole('columnheader', { name: /Added/ });
    expect(added.getAttribute('aria-sort')).toBe('descending');
    expect(screen.getByRole('columnheader', { name: /Score/ }).getAttribute('aria-sort')).toBeNull();
    fireEvent.click(within(added).getByRole('button'));
    expect(push).toHaveBeenCalledWith('/l?sort=oldest', { scroll: false });
    fireEvent.click(within(screen.getByRole('columnheader', { name: /Score/ })).getByRole('button'));
    expect(push).toHaveBeenLastCalledWith('/l?sort=score', { scroll: false });
    expect(within(screen.getByRole('columnheader', { name: 'Stage' })).queryByRole('button')).toBeNull();
  });

  it('pages with keyset links and a capped total', () => {
    const { rerender } = renderTable();
    const nav = screen.getByRole('navigation', { name: 'Lead pages' });
    expect(within(nav).getByRole('link', { name: 'Next page' }).getAttribute('href')).toBe('/l?cursor=abc');
    expect(within(nav).queryByRole('link', { name: 'Previous page' })).toBeNull();
    expect(nav.textContent).toContain('51 leads match');
    rerender(
      <CsrfProvider token="csrf-table">
        <LeadsTable
          rows={rows}
          total={{ count: 1000, capped: true }}
          sort="score"
          timeZone="Asia/Kolkata"
          sortHrefs={sortHrefs}
          prevHref="/l?cursor=p&dir=prev"
          nextHref={null}
          firstHref="/l"
          canMove={false}
          caption="Leads"
        />
      </CsrfProvider>,
    );
    expect(within(nav).getByRole('link', { name: 'Previous page' }).getAttribute('href')).toBe('/l?cursor=p&dir=prev');
    expect(within(nav).getByRole('link', { name: 'First page' })).toBeTruthy();
    expect(within(nav).queryByRole('link', { name: 'Next page' })).toBeNull();
    expect(nav.textContent).toContain('1,000+ leads match');
    expect(screen.queryAllByRole('button', { name: /^Move to stage/ })).toHaveLength(0);
    expect(screen.getByRole('columnheader', { name: /Score/ }).getAttribute('aria-sort')).toBe('descending');
  });
});

describe('LeadsToolbar', () => {
  it('is a GET search form; a changed filter navigates to the first page with the other filters kept', () => {
    render(<LeadsToolbar basePath="/dashboard/user/leads" params={parseLeadPageParams({ q: 'शर्मा', source: 'META_ADS', cursor: 'abc', view: 'table' })} />);
    const form = screen.getByRole('search', { name: 'Search and filter leads' });
    expect(form.getAttribute('method')).toBe('get');
    expect(form.getAttribute('action')).toBe('/dashboard/user/leads');
    expect((screen.getByLabelText('Search leads') as HTMLInputElement).value).toBe('शर्मा');
    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'REPLIED' } });
    expect(push).toHaveBeenCalledWith('/dashboard/user/leads?q=%E0%A4%B6%E0%A4%B0%E0%A5%8D%E0%A4%AE%E0%A4%BE&stage=REPLIED&source=META_ADS', { scroll: false });
    expect(screen.getByRole('link', { name: 'Clear filters' }).getAttribute('href')).toBe('/dashboard/user/leads');
    expect(screen.getByRole('link', { name: 'Table' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Board' }).getAttribute('href')).toBe('/dashboard/user/leads?view=board&q=%E0%A4%B6%E0%A4%B0%E0%A5%8D%E0%A4%AE%E0%A4%BE&source=META_ADS');
  });

  it('keeps keyboard focus on the changed select after the URL changes, and shows the new filters (ADR-73)', () => {
    const view = render(<LeadsToolbar basePath="/l" params={parseLeadPageParams({ q: 'asha' })} />);
    const stage = screen.getByLabelText('Stage') as HTMLSelectElement;
    stage.focus();
    fireEvent.change(stage, { target: { value: 'REPLIED' } });
    expect(push).toHaveBeenLastCalledWith('/l?q=asha&stage=REPLIED', { scroll: false });

    // The router delivers the new URL: the same select is still there and still focused.
    view.rerender(<LeadsToolbar basePath="/l" params={parseLeadPageParams({ q: 'asha', stage: 'REPLIED' })} />);
    expect(screen.getByLabelText('Stage')).toBe(stage);
    expect(document.activeElement).toBe(stage);
    expect(stage.value).toBe('REPLIED');

    const score = screen.getByLabelText('Score') as HTMLSelectElement;
    score.focus();
    fireEvent.change(score, { target: { value: 'high' } });
    view.rerender(<LeadsToolbar basePath="/l" params={parseLeadPageParams({ q: 'asha', stage: 'REPLIED', score: 'high' })} />);
    expect(document.activeElement).toBe(score);

    // Clear filters or the back button: the fields follow the URL.
    view.rerender(<LeadsToolbar basePath="/l" params={parseLeadPageParams({})} />);
    expect((screen.getByLabelText('Search leads') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Stage') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('Score') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('Sort') as HTMLSelectElement).value).toBe('newest');
  });

  it('the board view has no stage filter (its columns are the stages) and keeps view=board', () => {
    render(<LeadsToolbar basePath="/b" params={parseLeadPageParams({ view: 'board' })} />);
    expect(screen.queryByLabelText('Stage')).toBeNull();
    fireEvent.change(screen.getByLabelText('Score'), { target: { value: 'high' } });
    expect(push).toHaveBeenCalledWith('/b?view=board&score=high', { scroll: false });
  });
});
