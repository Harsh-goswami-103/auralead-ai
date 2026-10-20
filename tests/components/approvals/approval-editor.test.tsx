/**
 * ApprovalEditor focus management (employee report bug: opening the editor dropped focus on
 * <body>, WCAG 2.4.3): opening moves focus to the editor heading, Close and a save return it to the
 * "Edit quotation (new version)" button. The button sits in a self-start wrapper so it no longer
 * stretches across the column. Without quotes.edit it is gated by permission. The T15 editor is
 * replaced by a stub here: its own behavior is tested with the quotation pages.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalEditor } from '@/components/approvals/ApprovalEditor';

vi.mock('@/app/dashboard/user/quotations/quote-editor', () => ({
  QuoteEditor: (props: { submitLabel: string; onSaved?: () => void }) => (
    <button type="button" onClick={() => props.onSaved?.()}>
      {props.submitLabel}
    </button>
  ),
}));

afterEach(cleanup);

function renderEditor(canEdit = true) {
  return render(
    <ApprovalEditor
      approvalId="appr_1"
      workspaceSlug="smile-avenue-dental"
      quoteId="q_1"
      versionNo={1}
      pricingVersionId="pv_1"
      pricingVersionNo={3}
      catalog={{} as never}
      canEdit={canEdit}
      initial={{ items: [], discountKind: 'NONE', discountValue: '0', scopeText: '', timelineText: '', validityDays: null }}
    />,
  );
}

describe('ApprovalEditor', () => {
  it('opening focuses the editor heading; Close returns focus to the edit button', async () => {
    renderEditor();
    const trigger = screen.getByRole('button', { name: 'Edit quotation (new version)' });
    expect(trigger.parentElement?.className).toContain('self-start');
    await act(async () => fireEvent.click(trigger));
    const heading = screen.getByRole('heading', { level: 2, name: 'Edit v1' });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByText(/saves as v2/)).toBeTruthy();
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close.getAttribute('type')).toBe('button');
    await act(async () => fireEvent.click(close));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit quotation (new version)' }));
  });

  it('a save returns focus to the edit button', async () => {
    renderEditor();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Edit quotation (new version)' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save as v2' })));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit quotation (new version)' }));
  });

  it('without quotes.edit the control is gated by permission and does not open', async () => {
    renderEditor(false);
    const trigger = screen.getByRole('button', { name: 'Edit quotation (new version)' });
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    expect(trigger.getAttribute('data-gate-category')).toBe('permission');
    await act(async () => fireEvent.click(trigger));
    expect(screen.queryByRole('heading', { name: 'Edit v1' })).toBeNull();
  });
});
