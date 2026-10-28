/**
 * T25 dashboard components (06-design §11.3 command-center states; P10): a KPI tile renders its
 * final value with a "How it's counted" control that opens the exact definition; a failed widget
 * says "Not available" with the reference and a Retry that re-reads the page (router.refresh);
 * "Needs you" lists waiting items as links with counts and names the clear ones; the funnel says
 * counts and shares in text with Lost apart; the productivity table links every column to its
 * numbered definition and has no score column; durations read in plain units.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KpiTile } from '@/components/metrics/KpiTile';
import { NeedsYouList } from '@/components/metrics/NeedsYouList';
import { formatDuration, ProductivityTable } from '@/components/metrics/ProductivityTable';
import { StageFunnel } from '@/components/metrics/StageFunnel';
import { activityLabel } from '@/components/metrics/activity-vocabulary';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));

afterEach(() => {
  cleanup();
  refresh.mockReset();
});

describe('KpiTile', () => {
  it('shows the final value and opens the definition from "How it\'s counted"', async () => {
    render(<KpiTile label="Pipeline value" definition="Sum of SENT and VIEWED totals." state={{ ok: true, value: '₹7,110.00', hint: '2 quotations sent or opened' }} icon={<span />} />);
    expect(screen.getByText('₹7,110.00')).toBeTruthy();
    const trigger = screen.getByRole('button', { name: /How it's counted: Pipeline value/ });
    await act(async () => {
      fireEvent.click(trigger);
    });
    expect(screen.getByText('Sum of SENT and VIEWED totals.')).toBeTruthy();
  });

  it('a failed widget shows the reference and Retry re-reads the page', async () => {
    render(<KpiTile label="Open conversations" definition="Not closed." state={{ ok: false, reference: 'req_123' }} icon={<span />} />);
    expect(screen.getByText('Not available')).toBeTruthy();
    expect(screen.getByText(/Reference req_123/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('NeedsYouList', () => {
  const base = { definition: 'Counted from stored rows for this test.', tone: 'attention' as const };
  it('links waiting items with their counts and names the clear ones', () => {
    render(
      <NeedsYouList
        items={[
          { ...base, id: 'quoteApprovals', label: 'Quotations waiting for approval', href: '/dashboard/user/quotations?status=DRAFT', count: 3 },
          { ...base, id: 'failedDeliveries', label: 'Failed sends (7 days)', href: '/dashboard/user/inbox', count: 0, tone: 'problem' },
        ]}
      />,
    );
    const link = screen.getByRole('link', { name: /Quotations waiting for approval 3/ });
    expect(link.getAttribute('href')).toBe('/dashboard/user/quotations?status=DRAFT');
    expect(screen.getByText(/Nothing waiting: failed sends\./)).toBeTruthy();
  });

  it('says nothing needs you when every count is zero', () => {
    render(<NeedsYouList items={[{ ...base, id: 'takeoverThreads', label: 'Threads a person is handling', href: '/dashboard/user/inbox', count: 0, tone: 'info' }]} />);
    expect(screen.getByText('Nothing needs you right now.')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('StageFunnel', () => {
  it('states counts and shares in text, with Lost apart from the forward stages', () => {
    render(
      <StageFunnel
        total={10}
        stages={[
          { stage: 'NEW', count: 5 },
          { stage: 'CONTACTED', count: 2 },
          { stage: 'REPLIED', count: 1 },
          { stage: 'QUOTE_SENT', count: 1 },
          { stage: 'CONVERTED', count: 0 },
          { stage: 'LOST', count: 1 },
        ]}
      />,
    );
    const forward = screen.getByRole('list', { name: 'Leads in each forward sales stage' });
    expect(within(forward).getAllByRole('listitem')).toHaveLength(5);
    expect(within(forward).getByText('New').closest('li')?.textContent).toMatch(/5\s*50%/);
    const lost = screen.getByRole('list', { name: 'Leads marked lost' });
    expect(lost.textContent).toMatch(/Lost\s*1\s*10%/);
  });
});

describe('ProductivityTable', () => {
  const defs = [
    { id: 'leadsProcessed', label: 'Lead actions', definition: 'Stage changes and draft requests.' },
    { id: 'approvalsDecided', label: 'Approvals decided', definition: 'Approvals and rejections.' },
    { id: 'medianTimeToDecision', label: 'Median time to decision', definition: 'Wall clock.' },
    { id: 'messagesDispatched', label: 'Sends queued', definition: 'dispatch.queue rows.' },
    { id: 'quotesAcceptedAttributed', label: 'Accepted quotes attributed', definition: 'Last approver.' },
  ];
  it('links each column to its numbered definition and has no score column', () => {
    render(
      <ProductivityTable
        definitions={defs}
        assignmentsDefinition={{ id: 'assignments', label: 'Active assignments', definition: 'Assigned now.' }}
        rows={[{ userId: 'u1', name: 'Imran Qureshi', status: 'ACTIVE', activeAssignments: 2, leadsProcessed: 3, approvalsDecided: 3, medianTimeToDecisionMs: 4 * 3_600_000, decisionsTimed: 2, messagesDispatched: 2, quotesAcceptedAttributed: 1 }]}
      />,
    );
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent ?? '');
    expect(headers.join(' | ')).not.toMatch(/score|rank|efficien/i);
    for (const d of defs) {
      const ref = screen.getByRole('link', { name: `Definition of ${d.label}` });
      const target = document.getElementById(ref.getAttribute('href')!.slice(1));
      expect(target?.textContent).toContain(d.definition);
    }
    expect(screen.getByText('4 h')).toBeTruthy();
    expect(screen.getByText('from 2 decisions')).toBeTruthy();
  });

  it('formats durations in plain units', () => {
    expect(formatDuration(30_000)).toBe('under 1 min');
    expect(formatDuration(45 * 60_000)).toBe('45 min');
    expect(formatDuration(4.5 * 3_600_000)).toBe('4 h 30 min');
    expect(formatDuration(51 * 3_600_000)).toBe('2 d 3 h');
  });
});

describe('activity vocabulary', () => {
  it('never shows a dotted audit code', () => {
    expect(activityLabel('quote.accept')).toBe('Quotation accepted');
    expect(activityLabel('some.new_action')).toBe('Some new action');
  });
});

describe('activity labels that must not overstate an outcome (adversarial review)', () => {
  it('a template submission that is only queued or being confirmed is not "submitted for approval"', () => {
    expect(activityLabel('template.submit')).toBe('Template submission started');
  });
});
