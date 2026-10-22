/**
 * T28 IntegrationStatusCard and Test connection (PRD truthfulness; plan §12 GatedAction):
 *  - the stored status is icon + label + Simulated/Live; Not configured offers "Set up" (a link to
 *    the setup page: the working setup action), WhatsApp shows quality and limits as raw values or
 *    Unknown with the last check, and the internal cap is labelled as internal;
 *  - DEMO: Test connection posts with the workspace slug and says "Simulated, no provider
 *    contacted" with the status unchanged; it never says Connected;
 *  - LIVE and not configured: the button is gated on configuration (focusable, aria-disabled, the
 *    reason and the setup link visible) and sends nothing; without the capability it is gated on
 *    permission; a server refusal shows its message and reference;
 *  - credentials are only ever "saved + last four".
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationCard, type IntegrationCardData } from '@/components/integrations/IntegrationCard';
import { MaskedCredentials } from '@/components/integrations/MaskedCredentials';
import { CsrfProvider } from '@/components/patterns/csrf';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));

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

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const whatsapp: IntegrationCardData = {
  kind: 'WHATSAPP_CLOUD',
  slug: 'whatsapp',
  label: 'WhatsApp Cloud API',
  provider: 'Meta',
  summary: 'Approved template messages.',
  demoNote: 'DEMO sends WhatsApp messages to the demo transport. Meta is never contacted.',
  status: 'NOT_CONFIGURED',
  simulated: true,
  credentials: [{ saved: false }],
  lastCheckedAt: null,
  lastError: null,
  quality: { qualityRaw: null, messagingLimitRaw: null, checkedAt: null },
  internalDailyCap: 250,
  templates: { approved: 0, total: 0 },
};

function renderCard(props: Partial<{ card: IntegrationCardData; mode: 'demo' | 'live'; canManage: boolean }> = {}) {
  render(
    <CsrfProvider token="csrf-int">
      <IntegrationCard card={props.card ?? whatsapp} workspaceSlug="smile-avenue-dental" mode={props.mode ?? 'demo'} canManage={props.canManage ?? true} timeZone="Asia/Kolkata" />
    </CsrfProvider>,
  );
}

describe('IntegrationCard', () => {
  it('shows the stored status with its mode chip, Set up, Unknown quality and the internal cap label', () => {
    renderCard();
    expect(screen.getByRole('img', { name: 'Not configured, Simulated' })).toBeTruthy();
    const setup = screen.getByRole('link', { name: /^Set up/ });
    expect(setup.getAttribute('href')).toBe('/dashboard/employee/smile-avenue-dental/integrations/whatsapp');
    expect(screen.getByText(/Unknown · Unknown/)).toBeTruthy();
    expect(screen.getByText('Internal cap, not a provider limit')).toBeTruthy();
    expect(screen.getByText(/Meta is never contacted/)).toBeTruthy();
    expect(screen.getByText('None saved')).toBeTruthy();
  });

  it('DEMO: Test connection reports a simulated check, status unchanged, never Connected', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { outcome: 'SIMULATED', kind: 'WHATSAPP_CLOUD', status: 'NOT_CONFIGURED', message: 'Simulated, no provider contacted', errorCode: null }));
    renderCard();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Test connection' })));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/app/integrations/whatsapp/test');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ workspaceSlug: 'smile-avenue-dental' });
    expect((init as RequestInit).headers).toMatchObject({ 'x-csrf-token': 'csrf-int' });
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Simulated, no provider contacted');
    expect(status.textContent).toContain('Status unchanged: Not configured.');
    expect(status.textContent).not.toContain('Connected');
    expect(refresh).toHaveBeenCalled();
  });

  it('LIVE not configured: the test is gated on configuration with the setup link, and sends nothing', async () => {
    renderCard({ card: { ...whatsapp, simulated: false }, mode: 'live' });
    const button = screen.getByRole('button', { name: 'Test connection' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('data-gate-category')).toBe('configuration');
    expect(screen.getByText(/is not configured yet, so there is nothing to test/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open setup/ }).getAttribute('href')).toBe('/dashboard/employee/smile-avenue-dental/integrations/whatsapp');
    await act(async () => fireEvent.click(button));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('img', { name: 'Not configured, Live' })).toBeTruthy();
  });

  it('LIVE verification required: the test runs and the answer says so', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { outcome: 'VERIFICATION_REQUIRED', kind: 'WHATSAPP_CLOUD', status: 'CONFIGURED_UNVERIFIED', message: 'Verification required: WhatsApp Cloud API has not been verified with Meta, so its status stays as it is.', errorCode: null }));
    renderCard({ card: { ...whatsapp, simulated: false, status: 'CONFIGURED_UNVERIFIED', credentials: [{ saved: true }] }, mode: 'live' });
    expect(screen.getByRole('link', { name: /^Manage setup/ })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Test connection' })));
    expect(screen.getByRole('status').textContent).toContain('Verification required');
    expect(screen.getByText('1 of 1 saved, encrypted')).toBeTruthy();
  });

  it('without integrations.manage the test is gated on permission', () => {
    renderCard({ canManage: false });
    const button = screen.getByRole('button', { name: 'Test connection' });
    expect(button.getAttribute('data-gate-category')).toBe('permission');
    expect(screen.getByText(/does not include “Manage integrations”/)).toBeTruthy();
  });

  it('a refusal shows the server message and reference, not success', async () => {
    fetchMock.mockResolvedValueOnce(json(422, { code: 'INTEGRATION_NOT_CONFIGURED', message: 'WhatsApp Cloud API is not configured.', reference: 'req_42' }));
    renderCard({ card: { ...whatsapp, status: 'CONFIGURED_UNVERIFIED', simulated: false }, mode: 'live' });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Test connection' })));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('WhatsApp Cloud API is not configured.');
    expect(alert.textContent).toContain('req_42');
  });
});

describe('MaskedCredentials', () => {
  it('shows saved + last four or Not saved, nothing else', () => {
    render(
      <MaskedCredentials
        timeZone="Asia/Kolkata"
        items={[
          { field: 'accessToken', label: 'System user access token', saved: true, last4: '9xQz', updatedAt: new Date('2026-10-16T06:00:00.000Z') },
          { field: 'apiKey', label: 'API key', saved: true, last4: null, updatedAt: null },
          { field: 'password', label: 'Password', saved: false, last4: null, updatedAt: null },
        ]}
      />,
    );
    expect(screen.getByText('•••• 9xQz')).toBeTruthy();
    expect(screen.getByText(/Saved 16 Oct 2026/)).toBeTruthy();
    expect(screen.getByText('Saved, encrypted')).toBeTruthy();
    expect(screen.getByText('Not saved')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
