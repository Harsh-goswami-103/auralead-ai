/**
 * Lead detail actions: the page has one primary action (GlowFrame). "Create quote from proposal"
 * leads while no quotation waits for approval; once a draft quotation can be approved, its
 * "Approve vN" leads and the create button steps down to outline. Names, gates and requests are
 * unchanged either way.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import { DraftActions, QuoteApproveAction } from '@/app/dashboard/employee/[ws]/leads/[leadId]/lead-actions';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(cleanup);

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
