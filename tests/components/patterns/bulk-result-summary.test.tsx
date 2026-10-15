/**
 * BulkResultSummary (06-design F19, AT13, T23): the result drawer of a bulk run. It repeats the
 * workspace name, shows selected = queued + skipped + failed with icon + label (never colour only),
 * groups the skip and failure reasons with their labels and counts, lists every row with its
 * reasons, offers "Select skipped rows", and says plainly while the run is still in progress.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BulkResultSummary } from '@/components/patterns/BulkResultSummary';
import type { BulkRunDto } from '@/lib/schemas/bulk';

afterEach(cleanup);

const reason = (code: string, label: string) => ({ code, label });

const RUN: BulkRunDto = {
  id: 'run_1',
  action: 'SEND_EMAIL',
  status: 'COMPLETED',
  selected: 5,
  queued: 2,
  skipped: 2,
  failed: 1,
  preflight: { eligible: 2, skipped: 2, failed: 1 },
  rows: [
    { leadId: 'l1', leadName: 'Sharma Dental', outcome: 'QUEUED', reasons: [], deferred: false, messageId: 'm1' },
    { leadId: 'l2', leadName: 'Gupta Opticals', outcome: 'QUEUED', reasons: [reason('GLOBAL_PAUSED', 'Outbound is paused for the whole system')], deferred: true, messageId: 'm2' },
    { leadId: 'l3', leadName: 'Kapoor Sweets', outcome: 'SKIPPED', reasons: [reason('ATTESTED_MANUAL_ONLY', 'Attested B2B email allows manual single sends only')], deferred: false, messageId: null },
    { leadId: 'l4', leadName: 'Rao Fitness', outcome: 'SKIPPED', reasons: [reason('SUPPRESSED', 'The contact opted out on this channel')], deferred: false, messageId: null },
    { leadId: 'l5', leadName: 'Mehta Tiles', outcome: 'FAILED', reasons: [reason('CONTACT_MISSING', 'No contact for this channel')], deferred: false, messageId: null },
  ],
  byReason: [
    { code: 'ATTESTED_MANUAL_ONLY', label: 'Attested B2B email allows manual single sends only', count: 1 },
    { code: 'SUPPRESSED', label: 'The contact opted out on this channel', count: 1 },
    { code: 'CONTACT_MISSING', label: 'No contact for this channel', count: 1 },
  ],
  createdAt: '2026-10-16T06:00:00.000Z',
  startedAt: '2026-10-16T06:00:01.000Z',
  completedAt: '2026-10-16T06:00:02.000Z',
};

describe('BulkResultSummary', () => {
  it('shows the workspace, the counts that add up to the selection, and the grouped reasons', () => {
    render(<BulkResultSummary open onOpenChange={() => undefined} run={RUN} workspaceName="Smile Avenue Dental" />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Smile Avenue Dental/)).toBeTruthy();
    const counts = within(dialog).getByRole('list', { name: 'Result counts' });
    expect(counts.textContent).toContain('5 selected');
    expect(counts.textContent).toContain('2 queued');
    expect(counts.textContent).toContain('2 skipped');
    expect(counts.textContent).toContain('1 failed');
    const reasons = within(dialog).getByRole('list', { name: 'Reasons' });
    expect(reasons.textContent).toContain('Attested B2B email allows manual single sends only');
    expect(reasons.textContent).toContain('1');
    // Every row is listed with its outcome and reasons.
    const rows = within(dialog).getByRole('table');
    expect(within(rows).getAllByRole('row')).toHaveLength(6);
    expect(rows.textContent).toContain('Kapoor Sweets');
    expect(rows.textContent).toContain('Waiting: Outbound is paused for the whole system');
  });

  it('"Select skipped rows" hands back the skipped lead ids', () => {
    const onSelectRows = vi.fn();
    render(<BulkResultSummary open onOpenChange={() => undefined} run={RUN} workspaceName="Smile Avenue Dental" onSelectRows={onSelectRows} />);
    fireEvent.click(screen.getByRole('button', { name: 'Select skipped rows' }));
    expect(onSelectRows).toHaveBeenCalledWith(['l3', 'l4']);
  });

  it('says the run is still in progress until every row has a result', () => {
    const running: BulkRunDto = { ...RUN, status: 'RUNNING', queued: 1, skipped: 0, failed: 0, rows: RUN.rows.slice(0, 1), byReason: [], completedAt: null };
    render(<BulkResultSummary open onOpenChange={() => undefined} run={running} workspaceName="Smile Avenue Dental" />);
    expect(screen.getByRole('status').textContent).toContain('1 of 5 rows processed');
    expect(screen.queryByRole('button', { name: 'Select skipped rows' })).toBeNull();
  });
});
