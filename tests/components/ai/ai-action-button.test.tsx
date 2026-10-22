/**
 * Lead-gen B2: AiActionButton is the "Generate with AI" control of the inbox (F3), the template
 * studio (F4) and the handoff summary (F5).
 * - AI style: a violet outline button with a sparkle icon (violet only in src/components/ai/**).
 * - Loading: busy (aria-busy, spinner, pending label) while the action's promise runs or while the
 *   caller says the result is still pending (a queued job), and repeat clicks are ignored.
 * - `local`: the labelled local generator is not AI, so the same control reads "Generate with local
 *   template" with a neutral look and a wand icon (truthful UI).
 * - `gate`: a configuration, permission, mode or eligibility block renders the shared GatedAction
 *   (inert, focusable, with the reason), never violet, and never runs the action.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiActionButton } from '@/components/ai/AiActionButton';

afterEach(cleanup);

const VIOLET = /(?:^|\s)(?:hover:)?(?:text|bg|border)-ai(?:\/\d+)?(?:\s|$)/;

describe('AiActionButton', () => {
  it('reads "Generate with AI" by default, in the AI style with a sparkle icon', () => {
    render(<AiActionButton onAction={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Generate with AI' });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('data-ai-action')).toBe('ai');
    expect(button.className).toMatch(/(?:^|\s)text-ai(?:\s|$)/);
    expect(button.className).toMatch(/(?:^|\s)border-ai\/\d+(?:\s|$)/);
    // The AI colors replace the outline variant's neutral ones instead of fighting them.
    expect(button.className).not.toMatch(/(?:^|\s)text-fg-1(?:\s|$)/);
    expect(button.className).not.toMatch(/(?:^|\s)border-border-strong(?:\s|$)/);
    expect(button.querySelector('svg[data-icon="sparkles"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(button.getAttribute('aria-busy')).toBeNull();
  });

  it('runs the action, is busy with a spinner and the pending label meanwhile, and ignores repeat clicks', async () => {
    let resolve!: () => void;
    const onAction = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(<AiActionButton label="Write the template with AI" pendingLabel="Writing..." onAction={onAction} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Write the template with AI' }));
    });
    const busy = screen.getByRole('button', { name: 'Writing...' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    const spinner = busy.querySelector('svg[data-icon="spinner"]') as SVGElement;
    expect(spinner.getAttribute('class')).toContain('motion-safe:animate-spin');
    expect(spinner.getAttribute('aria-hidden')).toBe('true');
    expect(busy.querySelector('svg[data-icon="sparkles"]')).toBeNull();
    fireEvent.click(busy);
    expect(onAction).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
    expect(screen.getByRole('button', { name: 'Write the template with AI' }).getAttribute('aria-busy')).toBeNull();
  });

  it('pending from the caller (a queued job) shows busy and does not run the action again', () => {
    const onAction = vi.fn();
    render(<AiActionButton onAction={onAction} pending />);
    const busy = screen.getByRole('button', { name: 'Generating...' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(busy);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('local: reads "Generate with local template", neutral, with a wand icon', async () => {
    const onAction = vi.fn();
    render(<AiActionButton onAction={onAction} local />);
    const button = screen.getByRole('button', { name: 'Generate with local template' });
    expect(button.getAttribute('data-ai-action')).toBe('local');
    expect(VIOLET.test(button.className)).toBe(false);
    expect(button.querySelector('svg[data-icon="wand"]')).not.toBeNull();
    expect(button.querySelector('svg[data-icon="sparkles"]')).toBeNull();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('gated: the shared GatedAction look and reason, never violet, action not run', () => {
    const onAction = vi.fn();
    render(
      <AiActionButton
        onAction={onAction}
        gate={{ category: 'configuration', reason: 'No AI provider is connected for this workspace.', fix: { href: '/dashboard/employee/codecraft-web/integrations', label: 'Connect an AI provider' } }}
      />,
    );
    const button = screen.getByRole('button', { name: 'Generate with AI' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('data-gate-category')).toBe('configuration');
    expect(VIOLET.test(button.className)).toBe(false);
    expect(screen.getByText('No AI provider is connected for this workspace.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Connect an AI provider' }).getAttribute('href')).toBe('/dashboard/employee/codecraft-web/integrations');
    fireEvent.click(button);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('a null gate is an ordinary AI button', () => {
    render(<AiActionButton onAction={vi.fn()} gate={null} size="sm" className="w-full" />);
    const button = screen.getByRole('button', { name: 'Generate with AI' });
    expect(button.getAttribute('aria-disabled')).toBeNull();
    expect(button.getAttribute('data-size')).toBe('sm');
    expect(button.className).toContain('w-full');
  });
});
