/**
 * Lead detail actions: the page has one primary action (GlowFrame). "Create quote from proposal"
 * leads while no quotation waits for approval; once a draft quotation can be approved, its
 * "Approve vN" leads and the create button steps down to outline. Names, gates and requests are
 * unchanged either way. After "Generate draft" the page re-reads itself until the new draft is on
 * it; when the worker is late it says so without promising an update, and a second request after
 * that polls again.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import { DraftActions, QuoteApproveAction } from '@/app/dashboard/employee/[ws]/leads/[leadId]/lead-actions';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  refresh.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const draftProps = {
  leadId: 'lead_1',
  workspaceSlug: 'kesari-crafts',
  latestDraftId: 'draft_1',
  proposalDraftId: 'draft_1',
  localGeneratorAvailable: false,
  permissions: { canGenerateDraft: true, canCreateQuote: true },
};

function renderWithCsrf(node: React.ReactNode) {
  return render(<CsrfProvider token="csrf-leads">{node}</CsrfProvider>);
}

describe('lead detail primary action', () => {
  it('"Create quote from proposal" is the primary action by default', () => {
    renderWithCsrf(<DraftActions {...draftProps} />);
    const create = screen.getByRole('button', { name: 'Create quote from proposal' });
    expect(create.closest('[data-glow-frame]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Generate draft' }).closest('[data-glow-frame]')).toBeNull();
  });

  it('steps down when a waiting quotation is the primary action, and that approve button leads', () => {
    renderWithCsrf(
      <>
        <DraftActions {...draftProps} primary={false} />
        <QuoteApproveAction leadId="lead_1" quoteId="q_1" number="Q-0003" workspaceSlug="kesari-crafts" versionNo={1} gate={null} primary />
        <QuoteApproveAction leadId="lead_1" quoteId="q_0" number="Q-0002" workspaceSlug="kesari-crafts" versionNo={2} gate={null} />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Create quote from proposal' }).closest('[data-glow-frame]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve v1' }).closest('[data-glow-frame]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Approve v2' }).closest('[data-glow-frame]')).toBeNull();
    expect(document.querySelectorAll('[data-glow-frame]')).toHaveLength(1);
  });

  it('a gated approve is never framed as the primary action', () => {
    renderWithCsrf(
      <QuoteApproveAction
        leadId="lead_1"
        quoteId="q_1"
        number="Q-0003"
        workspaceSlug="kesari-crafts"
        versionNo={1}
        gate={{ category: 'permission', reason: 'Your assignment does not include approvals.decide. Ask a super admin to grant it.' }}
        primary
      />,
    );
    const approve = screen.getByRole('button', { name: 'Approve v1' });
    expect(approve.getAttribute('aria-disabled')).toBe('true');
    expect(approve.closest('[data-glow-frame]')).toBeNull();
  });
});

describe('waiting for a requested draft', () => {
  const accepted = () => new Response(JSON.stringify({ jobId: 'job_1' }), { status: 200, headers: { 'content-type': 'application/json' } });

  async function clickGenerate() {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Generate draft' }));
    });
  }

  it('a second request after the wait ran out starts polling again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchMock = vi.fn(async () => accepted());
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = renderWithCsrf(<DraftActions {...draftProps} proposalDraftId={null} />);

    await clickGenerate();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toContain('Waiting for the worker to write the draft');
    // The request's own refresh, then every 2 s for 30 s and every 5 s for a minute.
    act(() => vi.advanceTimersByTime(30_000 + 60_000));
    expect(refresh).toHaveBeenCalledTimes(1 + 15 + 12);
    act(() => vi.advanceTimersByTime(120_000));
    expect(refresh).toHaveBeenCalledTimes(28);
    const late = screen.getByRole('status').textContent;
    expect(late).toContain('The worker has not written the draft yet. Reload the page to check again.');
    expect(late).not.toContain('appears here when ready');

    // Same latest draft on the page, so the wait never ended; the new request still starts afresh.
    await clickGenerate();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(29);
    expect(screen.getByRole('status').textContent).toContain('Waiting for the worker to write the draft');
    act(() => vi.advanceTimersByTime(2_000));
    expect(refresh).toHaveBeenCalledTimes(30);

    // The worker's draft arrives: the note goes and polling stops.
    rerender(
      <CsrfProvider token="csrf-leads">
        <DraftActions {...draftProps} proposalDraftId={null} latestDraftId="draft_2" />
      </CsrfProvider>,
    );
    expect(screen.queryByRole('status')).toBeNull();
    act(() => vi.advanceTimersByTime(60_000));
    expect(refresh).toHaveBeenCalledTimes(30);
  });
});
