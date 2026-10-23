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
    expect(reason.textContent).toContain('Automatic sending is off for this workspace');
    expect(group.contains(reason)).toBe(false);
    expect(group.textContent).not.toContain('Automatic sending is off for this workspace');

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

  it('the takeover banner is a flat info tint: status hues never sit in a gradient', () => {
    renderControls({ humanTakeover: true });
    const banner = document.querySelector('[data-takeover-banner]') as HTMLElement;
    expect(banner.textContent).toContain('You are handling this thread. AI replies paused.');
    expect(banner.className).toContain('bg-info/12');
    expect(banner.className).not.toContain('gradient');
  });

  it('an ungated mode opens a confirmation naming the workspace', () => {
    renderControls();
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Workspace: Alpha Dental');
    expect(within(dialog).getByRole('button', { name: 'Set Off' })).toBeTruthy();
  });

  it('names the operator workspace in every request (ADR-121)', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ conversationId: 'conv_1', aiMode: 'OFF', humanTakeover: false, modeVersion: 4, changed: true }), { status: 200 }));
    renderControls({ workspaceSlug: 'codecraft-web' });
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Set Off' }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/app/conversations/conv_1/mode');
    expect(JSON.parse(String(init.body))).toEqual({ expectedModeVersion: 3, workspaceSlug: 'codecraft-web', aiMode: 'OFF' });
  });

  it('a handed-over thread is read-only for the operator: every control is gated with the reason (ADR-124)', async () => {
    const reason = 'Handed over to Codecraft Web Studio on 21 Oct 2026. Only the client messages this lead now.';
    renderControls({ readOnly: { reason }, autoSendEnabled: true });
    const group = screen.getByRole('group', { name: 'AI mode' });
    for (const name of ['Off', 'Auto']) {
      const button = within(group).getByRole('button', { name });
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.getAttribute('data-gate-category')).toBe('permission');
    }
    expect(screen.getByRole('button', { name: 'Take over' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getAllByText(reason).length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(within(group).getByRole('button', { name: 'Off' }));
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("after the handoff the banner names the client, not the operator, as handling the thread (the handoff takes the thread over)", () => {
    const reason = 'Handed over to Alpha Dental on 21 Oct 2026. Only the client messages this lead now.';
    renderControls({ readOnly: { reason }, humanTakeover: true, aiMode: 'OFF' });
    const banner = document.querySelector('[data-takeover-banner]') as HTMLElement;
    expect(banner.textContent).toContain('Alpha Dental is handling this thread. AI replies paused.');
    expect(banner.textContent).not.toContain('You are handling');
    // The operator cannot resume it: the control stays, gated with the reason.
    const resume = within(banner).getByRole('button', { name: 'Resume AI' });
    expect(resume.getAttribute('aria-disabled')).toBe('true');
  });
});
