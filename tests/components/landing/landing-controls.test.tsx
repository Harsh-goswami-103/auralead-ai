/**
 * Landing controls in jsdom (plan T30): the integrations marquee has its pause button (WCAG 2.2.2:
 * the loop runs longer than five seconds and hover pauses it for a mouse only) and the ROI
 * calculator's wording (a clamped field names the value really in use; the deals sentence
 * multiplies to the revenue headline).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { IntegrationsMarquee } from '@/components/landing/IntegrationsMarquee';
import { RoiCalculator } from '@/components/landing/RoiCalculator';

afterEach(cleanup);

describe('integrations marquee pause', () => {
  it('offers one real pause toggle that keyboard and touch users can reach', () => {
    render(<IntegrationsMarquee />);
    const buttons = screen.getAllByRole('button', { name: /pause/i });
    expect(buttons).toHaveLength(1);
    const button = buttons[0]!;
    // Not inside the inert, aria-hidden duplicate track.
    expect(button.closest('[inert], [aria-hidden="true"]')).toBeNull();
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('ROI calculator wording', () => {
  const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
  const hint = (input: HTMLInputElement) => document.getElementById(input.getAttribute('aria-describedby')!)!.textContent;

  it('names the clamped value at the precision the estimate uses, and writes that back on blur', () => {
    render(<RoiCalculator />);
    const hours = field('Hours saved per lead');
    fireEvent.change(hours, { target: { value: '0.255' } });
    expect(hint(hours)).toContain('Using 0.26.');
    fireEvent.blur(hours);
    expect(hours.value).toBe('0.26');

    const reply = field('Current reply rate');
    fireEvent.change(reply, { target: { value: '12.345' } });
    expect(hint(reply)).toContain('Using 12.35.');

    const leads = field('Leads per month');
    fireEvent.change(leads, { target: { value: '1e400' } });
    expect(hint(leads)).toContain('Using 1,00,000.');
  });

  it('explains the revenue with a deal count that multiplies to it', () => {
    const { container } = render(<RoiCalculator />);
    const result = container.querySelector('[data-roi-result]') as HTMLElement;
    fireEvent.change(field('Leads per month'), { target: { value: '7' } });
    expect(result.querySelector('output')!.textContent).toBe('₹2,100');
    expect(result.textContent).toContain('0.084 more deals a month at ₹25,000 each.');

    fireEvent.change(field('Leads per month'), { target: { value: '1' } });
    expect(result.querySelector('output')!.textContent).toBe('₹300');
    expect(result.textContent).toContain('0.012 more deals a month at ₹25,000 each.');

    fireEvent.change(field('Average deal value'), { target: { value: '1e400' } });
    fireEvent.change(field('Leads per month'), { target: { value: '7' } });
    expect(result.querySelector('output')!.textContent).toBe('₹84,00,000');
    expect(result.textContent).toContain('0.084 more deals a month at ₹10,00,00,000 each.');
  });
});
