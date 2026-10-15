/**
 * Plan §12 (O4) / 06-design F3: a gated control stays focusable (aria-disabled, never the
 * disabled attribute), shows its reason as visible text linked by aria-describedby, links to the
 * fix when one exists, and does not run its action. Ungated, the same control runs the action.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GATE_CATEGORIES, GatedAction } from '@/components/patterns/GatedAction';

afterEach(cleanup);

describe('GatedAction', () => {
  it('only accepts the four plan §12 categories', () => {
    expect([...GATE_CATEGORIES]).toEqual(['configuration', 'permission', 'mode', 'eligibility']);
  });

  it('gated: aria-disabled, focusable, visible reason, fix link, action not run', () => {
    const onAction = vi.fn();
    render(
      <GatedAction
        label="Send on WhatsApp"
        onAction={onAction}
        gate={{
          category: 'configuration',
          reason: 'WhatsApp is not configured for this workspace.',
          fix: { href: '/dashboard/employee/alpha/integrations', label: 'Configure WhatsApp' },
        }}
      />,
    );
    const button = screen.getByRole('button', { name: 'Send on WhatsApp' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.tabIndex).toBe(0);
    act(() => button.focus());
    expect(document.activeElement).toBe(button);

    const reason = screen.getByText('WhatsApp is not configured for this workspace.');
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(reason.closest(`[id="${describedBy}"]`)).not.toBeNull();

    const fix = screen.getByRole('link', { name: 'Configure WhatsApp' });
    expect(fix.getAttribute('href')).toBe('/dashboard/employee/alpha/integrations');

    fireEvent.click(button);
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(onAction).not.toHaveBeenCalled();
  });

  it('gated without a fix: reason shown, no link', () => {
    render(<GatedAction label="Approve" onAction={vi.fn()} gate={{ category: 'permission', reason: 'You need the approvals capability.' }} />);
    expect(screen.getByText('You need the approvals capability.')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve' }).getAttribute('data-gate-category')).toBe('permission');
  });

  it('ungated: a normal button that runs the action', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(<GatedAction label="Generate draft" onAction={onAction} gate={null} />);
    const button = screen.getByRole('button', { name: 'Generate draft' });
    expect(button.getAttribute('aria-disabled')).toBeNull();
    expect(button.getAttribute('aria-describedby')).toBeNull();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('ungated with href renders a link to the target', () => {
    render(<GatedAction label="Open pricing" href="/dashboard/user/pricing" gate={null} />);
    expect(screen.getByRole('link', { name: 'Open pricing' }).getAttribute('href')).toBe('/dashboard/user/pricing');
  });

  it('gated href control is a focusable aria-disabled link with no navigation target', () => {
    render(<GatedAction label="Open simulator" href="/demo/sim" gate={{ category: 'mode', reason: 'Simulators exist only in DEMO.' }} />);
    const control = screen.getByRole('link', { name: 'Open simulator' });
    expect(control.getAttribute('aria-disabled')).toBe('true');
    expect(control.hasAttribute('href')).toBe(false);
    expect(control.tabIndex).toBe(0);
    expect(screen.getByText('Simulators exist only in DEMO.')).toBeTruthy();
  });

  it('marks itself busy while the action runs and ignores repeat clicks', async () => {
    let resolve!: () => void;
    const onAction = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(<GatedAction label="Queue" pendingLabel="Queuing..." onAction={onAction} gate={null} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
    });
    const busy = screen.getByRole('button', { name: 'Queuing...' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(busy);
    expect(onAction).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
    expect(screen.getByRole('button', { name: 'Queue' })).toBeTruthy();
  });
});
