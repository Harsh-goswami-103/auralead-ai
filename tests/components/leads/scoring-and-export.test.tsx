/**
 * T26, P9: the scoring editor shows whether the weights add up to 100 (icon + label, live), previews
 * the draft on the server's 20-lead sample and activates it as the next version after a confirmation
 * that names the workspace, sending the active version it was opened with; the server's validation
 * issues are listed. ADR-70: the export panel is gated by leads.export (focusable, with the reason),
 * requests an export with a fresh request key and the current filters, and lists exports with their
 * status (icon + label) and a download link only while ready.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeadExportPanel } from '@/components/leads/LeadExportPanel';
import { ScoringEditor } from '@/components/leads/ScoringEditor';
import type { ScoringVersionDto } from '@/components/leads/ScoringConfigView';
import { CsrfProvider } from '@/components/patterns/csrf';
import type { LeadExportDto } from '@/lib/schemas/leads';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

afterEach(() => {
  cleanup();
  refresh.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubFetch(handler: (url: string, body: Record<string, unknown>) => Response) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url, body });
      return handler(url, body);
    }),
  );
  return calls;
}

const active: ScoringVersionDto = {
  id: 'scv_1',
  version: 1,
  active: true,
  createdAt: '2026-10-15T04:30:00.000Z',
  createdByName: 'Meera Krishnan',
  config: { schemaVersion: 1, weights: { phonePresent: 15, emailPresent: 10, websiteStatus: 20, rating: 20, reviewCount: 15, categoryMatch: 15, sourceIntent: 5 }, notes: 'Heuristic opportunity score.' },
};

function renderEditor() {
  return render(
    <CsrfProvider token="csrf-scoring">
      <ScoringEditor workspaceSlug="smile-avenue-dental" workspaceName="Smile Avenue Dental" active={active} history={[active]} />
    </CsrfProvider>,
  );
}

describe('ScoringEditor', () => {
  it('says live whether the weights add up to 100', () => {
    const { container } = renderEditor();
    const sum = () => container.querySelector('[data-weight-sum]') as HTMLElement;
    expect(sum().textContent).toBe('The weights add up to 100');
    expect(sum().querySelector('svg')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Phone on record'), { target: { value: '10' } });
    expect(sum().textContent).toBe('The weights add up to 95; they must add up to 100');
    fireEvent.change(screen.getByLabelText('Phone on record'), { target: { value: '15.5' } });
    expect(sum().textContent).toBe('Use whole numbers from 0 to 100');
  });

  it('previews the draft on the server sample and shows each lead now and with the draft', async () => {
    const calls = stubFetch(() =>
      json({
        preview: {
          sampleSize: 2,
          changed: 1,
          averageCurrent: 40,
          averageProposed: 52,
          rows: [
            { leadId: 'l1', displayName: 'राहुल शर्मा', currentScore: 40, proposedScore: 64, delta: 24, unknownInputs: 1 },
            { leadId: 'l2', displayName: 'Asha Raman', currentScore: 40, proposedScore: 40, delta: 0, unknownInputs: 2 },
          ],
        },
      }),
    );
    renderEditor();
    fireEvent.change(screen.getByLabelText('Phone on record'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Email on record'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Target categories'), { target: { value: 'Dental clinic\nOrthodontist' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Preview on 20 leads' }));
    });
    expect(calls[0]!.url).toBe('/api/app/scoring/preview');
    expect(calls[0]!.body).toMatchObject({
      workspaceSlug: 'smile-avenue-dental',
      config: { schemaVersion: 1, weights: { phonePresent: 5, emailPresent: 20 }, targetCategories: ['Dental clinic', 'Orthodontist'], websitePreference: 'PRESENT', reviewCountTarget: 100, notes: 'Heuristic opportunity score.' },
    });
    const preview = await screen.findByRole('region', { name: 'Preview' });
    expect(preview.textContent).toContain('1 of 2 would change. Average score 40 now, 52 with this draft.');
    expect(within(preview).getByText('+24')).toBeTruthy();
  });

  it('lists the server validation issues', async () => {
    stubFetch(() => json({ code: 'SCORING_CONFIG_INVALID', message: 'The scoring configuration is not valid. Fix the marked fields and try again.', reference: 'req_9', details: { issues: [{ path: 'weights', message: 'weights must sum to 100 (got 105)' }] } }, 400));
    renderEditor();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Preview on 20 leads' }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('weights: weights must sum to 100 (got 105)');
  });

  it('activates the draft as the next version after a confirmation naming the workspace', async () => {
    const calls = stubFetch(() => json({ activated: { versionId: 'scv_2', version: 2, previousVersion: 1, rescoreJobId: 'job_1' } }));
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Activate as version 2' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Workspace: Smile Avenue Dental');
    expect(dialog.textContent).toContain('the worker rescores every lead');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Activate version 2' }));
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls[0]!.url).toBe('/api/app/scoring/versions');
    expect(calls[0]!.body).toMatchObject({ workspaceSlug: 'smile-avenue-dental', expectedActiveVersion: 1 });
    expect(toast.success).toHaveBeenCalledWith('Scoring version 2 is active.', expect.anything());
  });

  it('refuses to activate weights that do not add up, without calling the server', async () => {
    const calls = stubFetch(() => json({}));
    renderEditor();
    fireEvent.change(screen.getByLabelText('Rating'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Activate as version 2' }));
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Activate version 2' }));
    });
    expect(within(dialog).getByRole('alert').textContent).toContain('add up to 100');
    expect(calls).toHaveLength(0);
  });
});

const exportRow = (id: string, status: LeadExportDto['effectiveStatus']): LeadExportDto => ({
  id,
  status: status === 'EXPIRED' ? 'READY' : status,
  effectiveStatus: status,
  filters: { sort: 'newest' },
  rowCount: status === 'QUEUED' ? null : 51,
  truncated: false,
  bytes: status === 'QUEUED' ? null : 4096,
  createdAt: '2026-10-16T06:00:00.000Z',
  completedAt: status === 'QUEUED' ? null : '2026-10-16T06:01:00.000Z',
  expiresAt: status === 'QUEUED' ? null : '2026-10-17T06:01:00.000Z',
  downloadCount: 0,
});

describe('LeadExportPanel', () => {
  it('is gated without leads.export: focusable, with the reason, and nothing is requested', () => {
    const calls = stubFetch(() => json({}));
    render(
      <CsrfProvider token="csrf-export">
        <LeadExportPanel exports={[]} filters={{ sort: 'newest' }} gate={{ category: 'permission', reason: 'Only the workspace owner can export leads (leads.export).' }} timeZone="Asia/Kolkata" filtered={false} />
      </CsrfProvider>,
    );
    const button = screen.getByRole('button', { name: 'Export all leads (CSV)' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(screen.getByText('Only the workspace owner can export leads (leads.export).')).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('requests an export of the current filters with a fresh request key', async () => {
    const calls = stubFetch(() => json({ export: exportRow('exp_1', 'QUEUED'), created: true }));
    render(
      <CsrfProvider token="csrf-export">
        <LeadExportPanel exports={[]} filters={{ q: 'शर्मा', stage: 'NEW', sort: 'score' }} gate={null} workspaceSlug="smile-avenue-dental" timeZone="Asia/Kolkata" filtered />
      </CsrfProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export matching leads (CSV)' }));
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls[0]!.url).toBe('/api/app/leads/exports');
    expect(calls[0]!.body).toMatchObject({ filters: { q: 'शर्मा', stage: 'NEW', sort: 'score' }, workspaceSlug: 'smile-avenue-dental' });
    expect(calls[0]!.body.requestKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it('lists exports with status chips and a download link only while ready', () => {
    const { container } = render(
      <CsrfProvider token="csrf-export">
        <LeadExportPanel exports={[exportRow('exp_q', 'QUEUED'), exportRow('exp_r', 'READY'), exportRow('exp_x', 'EXPIRED')]} filters={{ sort: 'newest' }} gate={null} workspaceSlug="smile-avenue-dental" timeZone="Asia/Kolkata" filtered={false} />
      </CsrfProvider>,
    );
    const item = (id: string) => container.querySelector(`[data-export-id="${id}"]`) as HTMLElement;
    expect(item('exp_q').textContent).toContain('Preparing');
    expect(within(item('exp_q')).queryByRole('link')).toBeNull();
    const download = within(item('exp_r')).getByRole('link', { name: 'Download CSV' });
    expect(download.getAttribute('href')).toBe('/api/app/leads/exports/exp_r/download?workspaceSlug=smile-avenue-dental');
    expect(item('exp_r').textContent).toContain('51 leads');
    expect(item('exp_x').textContent).toContain('Expired');
    expect(within(item('exp_x')).queryByRole('link')).toBeNull();
  });
});
