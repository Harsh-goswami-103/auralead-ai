/**
 * 06-design F8, F19, F20: a confirm dialog states what will happen, repeats the workspace name
 * for tenant actions, runs the confirm action once (busy while pending), keeps the dialog open
 * with the error and reference when the action fails, and cancels without running anything.
 * The workspace chip wraps rather than truncating, so a long name stays whole on a phone and
 * cannot push the dialog's text and buttons past its edge.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';

afterEach(cleanup);

function openDialog(props: Partial<Parameters<typeof ConfirmDialog>[0]> & { onConfirm: Parameters<typeof ConfirmDialog>[0]['onConfirm'] }) {
  render(
    <ConfirmDialog
      trigger={<button type="button">Pause campaign</button>}
      title="Pause Diwali offer?"
      description="Status changes from Active to Paused. This is audited."
      confirmLabel="Pause campaign"
      workspaceName="Alpha Dental"
      {...props}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Pause campaign' }));
}

describe('ConfirmDialog', () => {
  it('shows title, description and the workspace name', () => {
    openDialog({ onConfirm: vi.fn() });
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Pause Diwali offer?');
    expect(dialog.textContent).toContain('Status changes from Active to Paused. This is audited.');
    expect(dialog.textContent).toContain('Workspace: Alpha Dental');
  });

  it('keeps the whole workspace name: the chip wraps and no grid track can widen the dialog', () => {
    openDialog({ onConfirm: vi.fn(), workspaceName: 'Smile Avenue Dental Clinic', destructive: true });
    const dialog = screen.getByRole('alertdialog');
    const text = within(dialog).getByText('Workspace: Smile Avenue Dental Clinic', { selector: 'span' });
    // A nowrap (truncate) line sets the auto grid tracks' min-content wider than a 360px dialog.
    expect(text.className).not.toMatch(/\btruncate\b|whitespace-nowrap/);
    expect(text.classList.contains('wrap-anywhere')).toBe(true);
    expect(text.parentElement!.className).not.toMatch(/\bw-fit\b|\binline-flex\b/);
    expect(dialog.classList.contains('grid-cols-[minmax(0,1fr)]')).toBe(true);
    expect(text.closest('[data-slot="alert-dialog-header"]')!.classList.contains('grid-cols-[minmax(0,1fr)]')).toBe(true);
  });

  it('confirm runs the action once and closes on success', async () => {
    const onConfirm = vi.fn().mockResolvedValue({ ok: true });
    openDialog({ onConfirm });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause campaign' }));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('a failed action keeps the dialog open with message and reference', async () => {
    const onConfirm = vi.fn().mockResolvedValue({ ok: false, message: 'Meta rejected the change.', reference: 'req_meta000001' });
    openDialog({ onConfirm });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause campaign' }));
    });
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Meta rejected the change.');
    expect(dialog.textContent).toContain('req_meta000001');
  });

  it('cancel closes without running the action', () => {
    const onConfirm = vi.fn();
    openDialog({ onConfirm });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('is busy while pending and ignores a second confirm', async () => {
    let resolve!: (v: { ok: true }) => void;
    const onConfirm = vi.fn(() => new Promise<{ ok: true }>((r) => (resolve = r)));
    openDialog({ onConfirm, pendingLabel: 'Pausing...' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause campaign' }));
    });
    const busy = screen.getByRole('button', { name: 'Pausing...' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(busy);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ ok: true }));
  });
});
