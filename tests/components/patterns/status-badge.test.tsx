/**
 * Plan §10 / 06-design §11.6, F2, F6: one status vocabulary. Every IntegrationStatus and every
 * delivery display state (including Unknown and a simulated record) renders an icon, a text
 * label and a mode chip, so status is never color-only and a simulated result can never look
 * like a real one.
 */
import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DeliveryStatusBadge, IntegrationStatusBadge } from '@/components/patterns/StatusBadge';
import { DELIVERY_STATUS_VOCABULARY, INTEGRATION_STATUS_VOCABULARY } from '@/components/patterns/status-vocabulary';
import { IntegrationStatus, MessageStatus } from '@/lib/domain/enums';

afterEach(cleanup);

function parts(container: HTMLElement) {
  const badge = container.querySelector('[data-status-badge]');
  expect(badge).not.toBeNull();
  const el = badge as HTMLElement;
  const icon = el.querySelector('svg');
  const label = el.querySelector('[data-status-label]');
  const chip = el.querySelector('[data-mode-chip]');
  return { el, icon, label: label?.textContent ?? null, chip: chip?.textContent ?? null };
}

describe('IntegrationStatusBadge', () => {
  it('has a vocabulary entry for every IntegrationStatus and nothing else', () => {
    expect(Object.keys(INTEGRATION_STATUS_VOCABULARY).sort()).toEqual([...IntegrationStatus].sort());
  });

  for (const status of IntegrationStatus) {
    for (const simulated of [false, true]) {
      it(`${status} (${simulated ? 'simulated' : 'live'}) renders icon + label + mode chip`, () => {
        const { container } = render(<IntegrationStatusBadge status={status} simulated={simulated} />);
        const p = parts(container);
        expect(p.icon).not.toBeNull();
        expect(p.icon!.getAttribute('aria-hidden')).toBe('true');
        expect(p.label).toBe(INTEGRATION_STATUS_VOCABULARY[status].label);
        expect(p.label!.length).toBeGreaterThan(0);
        expect(p.chip).toBe(simulated ? 'Simulated' : 'Live');
        expect(p.el.getAttribute('data-tone')).toBe(INTEGRATION_STATUS_VOCABULARY[status].tone);
      });
    }
  }

  it('uses the 06-design labels', () => {
    const labels = Object.fromEntries(IntegrationStatus.map((s) => [s, INTEGRATION_STATUS_VOCABULARY[s].label]));
    expect(labels).toEqual({
      NOT_CONFIGURED: 'Not configured',
      CONFIGURED_UNVERIFIED: 'Verification required',
      VERIFYING: 'Verifying',
      CONNECTED: 'Connected',
      DEGRADED: 'Limited',
      ERROR: 'Connection failed',
      REVOKED: 'Revoked',
      SIMULATED: 'Demo simulation',
    });
  });

  it('shows the last check time for CONNECTED in the workspace timezone', () => {
    const { container } = render(
      <IntegrationStatusBadge status="CONNECTED" simulated={false} checkedAt={new Date('2026-10-15T08:35:00.000Z')} />,
    );
    const badge = container.querySelector('[data-status-badge]') as HTMLElement;
    expect(within(badge).getByText(/checked 15 Oct 2026, 2:05 pm IST/)).toBeTruthy();
  });

  it('gives the accessible name label plus mode', () => {
    const { container } = render(<IntegrationStatusBadge status="ERROR" simulated />);
    const badge = container.querySelector('[data-status-badge]') as HTMLElement;
    expect(badge.getAttribute('aria-label')).toBe('Connection failed, Simulated');
  });
});

describe('DeliveryStatusBadge', () => {
  it('has a vocabulary entry for every MessageStatus', () => {
    expect(Object.keys(DELIVERY_STATUS_VOCABULARY).sort()).toEqual([...MessageStatus].sort());
  });

  for (const status of MessageStatus) {
    for (const simulated of [false, true]) {
      it(`${status} (${simulated ? 'simulated' : 'live'}) renders icon + label + mode chip`, () => {
        const { container } = render(<DeliveryStatusBadge status={status} simulated={simulated} />);
        const p = parts(container);
        expect(p.icon).not.toBeNull();
        expect(p.icon!.getAttribute('aria-hidden')).toBe('true');
        expect(p.label).toBe(DELIVERY_STATUS_VOCABULARY[status].label);
        expect(p.chip).toBe(simulated ? 'Simulated' : 'Live');
      });
    }
  }

  it('renders the ambiguous outcome as Unknown (provider timeout) with the no-resend note', () => {
    const { container } = render(<DeliveryStatusBadge status="UNKNOWN" simulated={false} showDetail />);
    const p = parts(container);
    expect(p.label).toBe('Unknown (provider timeout)');
    expect(container.textContent).toContain('Not retried automatically to avoid a duplicate');
  });

  it('never labels a failure as success', () => {
    expect(DELIVERY_STATUS_VOCABULARY.FAILED.tone).toBe('danger');
    expect(DELIVERY_STATUS_VOCABULARY.UNKNOWN.tone).toBe('warning');
    expect(DELIVERY_STATUS_VOCABULARY.NOT_SENT.label).toBe('Not sent');
  });
});
