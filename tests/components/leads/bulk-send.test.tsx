/**
 * PRD employee console "bulk selection + eligible/skipped counts" (T23 backend, wired by T26): rows
 * are selected with checkboxes (one per row, plus "every lead on this page"); "Bulk send" is gated
 * by permission (focusable, with the reason); the dialog checks eligibility first through the
 * server's pre-flight and shows its eligible, skipped and failed counts with the reasons; confirming
 * queues only the eligible rows as one run with one request key and opens the persisted result.
 * Without an approved WhatsApp template the template option says why (configuration).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BulkLeadsTable } from '@/components/leads/BulkLeadsTable';
import type { LeadRowDto } from '@/components/leads/types';
import { CsrfProvider } from '@/components/patterns/csrf';
import type { BulkPreflightDto, BulkRunDto } from '@/lib/schemas/bulk';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const row = (id: string, name: string): LeadRowDto => ({
  id,
  displayName: name,
  city: null,
  category: null,
  phoneE164: '+919876543210',
  emailNormalized: `${id}@example.test`,
  firstSource: 'GOOGLE_SHEETS',
  salesStage: 'NEW',
  stageVersion: 0,
  score: null,
  simulated: false,
  createdAt: '2026-10-16T06:00:00.000Z',
  href: `/dashboard/employee/smile-avenue-dental/leads/${id}`,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function renderTable(overrides: { sendGate?: { category: 'permission'; reason: string } | null; templates?: Array<{ id: string; name: string; language: string }> } = {}) {
  return render(
    <CsrfProvider token="csrf-bulk">
      <BulkLeadsTable
        rows={[row('l1', 'Asha Raman'), row('l2', 'राहुल शर्मा')]}
        total={{ count: 2, capped: false }}
        sort="newest"
        timeZone="Asia/Kolkata"
        sortHrefs={{ newest: '/l', oldest: '/l', score: '/l', name: '/l' }}
        prevHref={null}
        nextHref={null}
        firstHref={null}
        canMove={false}
        caption="Leads"
        workspaceSlug="smile-avenue-dental"
        workspaceName="Smile Avenue Dental"
        templates={overrides.templates ?? []}
        sendGate={overrides.sendGate ?? null}
      />
    </CsrfProvider>,
  );
}

const preflight: BulkPreflightDto = {
  selected: 2,
  eligible: 1,
  skipped: 1,
  failed: 0,
  rows: [],
  byReason: [{ code: 'SUPPRESSED', label: 'The contact opted out on this channel', count: 1 }],
};

const run: BulkRunDto = {
  id: 'run_1',
  action: 'SEND_EMAIL',
  status: 'COMPLETED',
  selected: 2,
  queued: 1,
  skipped: 1,
  failed: 0,
  preflight: { eligible: 1, skipped: 1, failed: 0 },
  rows: [
    { leadId: 'l1', leadName: 'Asha Raman', outcome: 'QUEUED', reasons: [], deferred: false, messageId: 'm1' },
    { leadId: 'l2', leadName: 'राहुल शर्मा', outcome: 'SKIPPED', reasons: [{ code: 'SUPPRESSED', label: 'The contact opted out on this channel' }], deferred: false, messageId: null },
  ],
  byReason: [{ code: 'SUPPRESSED', label: 'The contact opted out on this channel', count: 1 }],
  createdAt: '2026-10-16T06:00:00.000Z',
  startedAt: '2026-10-16T06:00:01.000Z',
  completedAt: '2026-10-16T06:00:02.000Z',
};

describe('bulk selection and send', () => {
  it('selects rows one by one or the whole page, and the first link of the table is still the lead', () => {
    renderTable();
    expect(screen.queryByRole('region', { name: 'Bulk actions' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Asha Raman' }));
    expect(within(screen.getByRole('region', { name: 'Bulk actions' })).getByText('1 lead selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select every lead on this page' }));
    expect(screen.getByText('2 leads selected')).toBeTruthy();
    expect(within(screen.getByRole('table')).getAllByRole('link')[0]!.textContent).toBe('Asha Raman');
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByRole('region', { name: 'Bulk actions' })).toBeNull();
  });

  it('is gated by permission: focusable, with the reason, no dialog', () => {
    renderTable({ sendGate: { category: 'permission', reason: 'Bulk sends need approvals.decide, which your assignment does not include.' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Asha Raman' }));
    const send = screen.getByRole('button', { name: 'Bulk send' });
    expect(send.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(send);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Bulk sends need approvals.decide, which your assignment does not include.')).toBeTruthy();
  });

  it('checks eligibility through the pre-flight, then queues only the eligible rows once and shows the persisted result', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
        return url === '/api/app/bulk/preflight' ? json(preflight) : json({ run });
      }),
    );
    renderTable();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select every lead on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk send' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send to 2 selected leads' });
    expect(dialog.textContent).toContain('Smile Avenue Dental');
    expect((within(dialog).getByRole('button', { name: 'Check eligibility' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Subject'), { target: { value: 'Diwali check-up offer' } });
    fireEvent.change(within(dialog).getByLabelText('Message'), { target: { value: 'Book a free check-up this week.' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Check eligibility' }));
    });
    expect(calls[0]).toEqual({
      url: '/api/app/bulk/preflight',
      body: { action: 'SEND_EMAIL', subject: 'Diwali check-up offer', body: 'Book a free check-up this week.', leadIds: ['l1', 'l2'], workspaceSlug: 'smile-avenue-dental' },
    });
    const eligibility = within(dialog).getByRole('region', { name: 'Eligibility' });
    expect(eligibility.textContent).toContain('1 eligible');
    expect(eligibility.textContent).toContain('1 skipped');
    expect(eligibility.textContent).toContain('The contact opted out on this channel');

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Queue 1 eligible send' }));
    });
    expect(calls[1]!.url).toBe('/api/app/bulk/runs');
    expect(calls[1]!.body).toMatchObject({ action: 'SEND_EMAIL', leadIds: ['l1', 'l2'], workspaceSlug: 'smile-avenue-dental' });
    expect(calls[1]!.body.requestKey).toMatch(/^[0-9a-f]{32}$/);
    const drawer = await screen.findByRole('dialog', { name: 'Bulk email send' });
    expect(drawer.textContent).toContain('Workspace: Smile Avenue Dental');
    await waitFor(() => expect(screen.queryByText('2 leads selected')).toBeNull());
    // "Select skipped rows" hands the skipped lead back to the table.
    fireEvent.click(within(drawer).getByRole('button', { name: 'Select skipped rows' }));
    expect((screen.getByRole('checkbox', { name: 'Select राहुल शर्मा' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Select Asha Raman' }) as HTMLInputElement).checked).toBe(false);
  });

  it('a WhatsApp bulk send without an approved template says why (configuration)', async () => {
    renderTable();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Asha Raman' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk send' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Channel'), { target: { value: 'SEND_WHATSAPP_TEMPLATE' } });
    expect(dialog.textContent).toContain('No approved WhatsApp template is available for this workspace');
    // The gate points at the template studio, where a template can be written and submitted.
    expect(within(dialog).getByRole('link', { name: /Open templates/ }).getAttribute('href')).toMatch(/^\/dashboard\/employee\/[^/]+\/templates$/);
    expect((within(dialog).getByRole('button', { name: 'Check eligibility' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
