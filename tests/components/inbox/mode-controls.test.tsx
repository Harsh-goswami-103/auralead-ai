/**
 * Inbox AI mode control (T22 over the Aurora redesign; user report "segmented control breaks"): the
 * three modes are one role=group "AI mode" whose current mode reads exactly "Draft for approval"; a
 * gated Auto stays inside the group as an aria-disabled button with its lock, while its reason is
 * printed once outside the group and tied to the button by aria-describedby. A blocked click posts
 * nothing. An ungated mode opens the confirmation that names the workspace.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import { ModeControls, type ModeControlsProps } from '@/components/inbox/ModeControls';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const base: ModeControlsProps = {
  conversationId: 'conv_1',
  workspaceName: 'Alpha Dental',
  aiMode: 'DRAFT',
  humanTakeover: false,
  modeVersion: 3,
  autoSendEnabled: false,
  autoAvailable: true,
  canChangeMode: true,
};

function renderControls(props: Partial<ModeControlsProps> = {}) {
  render(
    <CsrfProvider token="csrf-mode">
      <ModeControls {...base} {...props} />
    </CsrfProvider>,
  );
}

describe('ModeControls', () => {
  it('renders one segmented group with the current mode and a gated Auto whose reason sits outside the group', async () => {
    renderControls();
    const group = screen.getByRole('group', { name: 'AI mode' });
    const current = group.querySelector('[data-ai-mode="DRAFT"]');
    expect(current?.textContent).toBe('Draft for approval');
    expect(within(group).getByRole('button', { name: 'Off' })).toBeTruthy();

    const auto = within(group).getByRole('button', { name: 'Auto' });
    expect(auto.getAttribute('aria-disabled')).toBe('true');
    expect(auto.getAttribute('data-gate-category')).toBe('configuration');
    const reasonId = auto.getAttribute('aria-describedby')!;
    const reason = document.getElementById(reasonId)!;
    expect(reason.textContent).toContain('Workspace auto-send is off');
    expect(group.contains(reason)).toBe(false);
    expect(group.textContent).not.toContain('Workspace auto-send is off');

    await act(async () => {
      fireEvent.click(auto);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prints a shared reason once when every other segment is gated by permission', () => {
    renderControls({ canChangeMode: false });
    const group = screen.getByRole('group', { name: 'AI mode' });
    const off = within(group).getByRole('button', { name: 'Off' });
    const auto = within(group).getByRole('button', { name: 'Auto' });
    expect(off.getAttribute('aria-describedby')).toBe(auto.getAttribute('aria-describedby'));
    expect(screen.getAllByText('Your role cannot change how this conversation is handled.')).toHaveLength(2);
    // one for the shared segment reason, one under the gated Take over control
    expect(screen.getByRole('button', { name: 'Take over' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('an ungated mode opens a confirmation naming the workspace', () => {
    renderControls();
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Workspace: Alpha Dental');
    expect(within(dialog).getByRole('button', { name: 'Set Off' })).toBeTruthy();
  });
});
