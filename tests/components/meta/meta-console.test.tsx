/**
 * T35 Meta console controls (AT14 UI path; PRD "pause/resume with confirmation ... provider
 * result"; plan §12): the pause dialog needs the typed word, sends one request key with the target
 * status, and keeps a refusal visible (never shown as success); a failed or unknown action shows
 * icon plus label with Meta's reason; a gated control stays focusable with its reason and sends
 * nothing; "Sync campaigns" reports the currency the metrics are in; the backfill and form mapping
 * forms post their bodies.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import { BackfillForm } from '@/app/dashboard/employee/[ws]/meta/backfill-form';
import { CampaignControl } from '@/app/dashboard/employee/[ws]/meta/campaign-control';
import { CampaignSyncButton } from '@/app/dashboard/employee/[ws]/meta/campaign-sync-button';
import { FormMappingForm } from '@/app/dashboard/employee/[ws]/meta/form-mapping-form';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }), usePathname: () => '/dashboard/employee/smile-avenue-dental/meta' }));
const toastSuccess = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn() } }));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  toastSuccess.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const wrap = (node: ReactNode) => render(<CsrfProvider token="csrf-meta">{node}</CsrfProvider>);
const control = (overrides: Partial<Parameters<typeof CampaignControl>[0]> = {}) => (
  <CampaignControl workspaceSlug="smile-avenue-dental" workspaceName="Smile Avenue Dental" campaignId="cmp_1" campaignName="Free check-up" configuredStatus="ACTIVE" latest={null} gate={null} {...overrides} />
);

describe('CampaignControl', () => {
  it('pausing needs the typed word PAUSE; then it posts the target, the word and one request key', async () => {
    fetchMock.mockResolvedValue(json(200, { state: 'SIMULATED', simulated: true, created: true }));
    wrap(control());
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Workspace: Smile Avenue Dental')).toBeTruthy();
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Pause' })));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('alert').textContent).toContain('Type PAUSE to confirm.');
    fireEvent.change(within(dialog).getByLabelText('Type PAUSE to confirm'), { target: { value: 'pause' } });
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Pause' })));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/app/campaigns/cmp_1/status');
    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, string>;
    expect(body).toMatchObject({ workspaceSlug: 'smile-avenue-dental', targetStatus: 'PAUSED', confirm: 'PAUSE' });
    expect(body.requestKey).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(toastSuccess.mock.calls[0]![0]).toBe('Paused (simulated)');
    expect(refresh).toHaveBeenCalled();
  });

  it('a paused campaign offers Resume with RESUME; a refusal (412) stays visible and reuses the request key on retry', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(412, { code: 'INTEGRATION_NOT_VERIFIED', message: 'Meta Lead Ads is not verified.', reference: 'req_1' })));
    wrap(control({ configuredStatus: 'PAUSED' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByLabelText('Type RESUME to confirm'), { target: { value: 'RESUME' } });
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Resume' })));
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Resume' })));
    expect(within(dialog).getByRole('alert').textContent).toContain('Meta Lead Ads is not verified.');
    const keys = fetchMock.mock.calls.map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { requestKey: string }).requestKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('shows the newest action as icon plus label with Meta’s reason; never success for a failure', () => {
    wrap(control({ latest: { state: 'FAILED', targetStatus: 'PAUSED', reasonCode: 'PERMISSION_MISSING', message: 'Missing permission: ads_management.', readBackStatus: null } }));
    expect(screen.getByText('Failed, nothing changed')).toBeTruthy();
    expect(screen.getByText('A permission is missing')).toBeTruthy();
    expect(screen.getByText('Missing permission: ads_management.')).toBeTruthy();
    expect(screen.queryByText('Confirmed by Meta')).toBeNull();
  });

  it('while Meta is still confirming (UNKNOWN) the control is gated and says so', async () => {
    wrap(control({ latest: { state: 'UNKNOWN', targetStatus: 'PAUSED', reasonCode: 'WRITE_TIMEOUT', message: null, readBackStatus: null } }));
    expect(screen.getByText('Unknown, confirming with Meta')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Pause' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await act(async () => fireEvent.click(button));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a configuration gate (LIVE, not verified) stays focusable with its reason and sends nothing', async () => {
    wrap(control({ gate: { category: 'configuration', reason: 'Campaigns can be paused or resumed once Meta Lead Ads is connected and verified.', fix: { href: '/setup', label: 'Open setup' } } }));
    const button = screen.getByRole('button', { name: 'Pause' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('data-gate-category')).toBe('configuration');
    expect(screen.getByText(/once Meta Lead Ads is connected and verified/)).toBeTruthy();
    await act(async () => fireEvent.click(button));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('CampaignSyncButton', () => {
  it('reports the campaigns and the currency the metrics are in', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { simulated: false, currency: 'USD', campaigns: 2, snapshots: 1, skipped: 0, complete: true }));
    wrap(<CampaignSyncButton workspaceSlug="live-co" gate={null} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sync campaigns' })));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/app/campaigns/sync');
    expect(screen.getByRole('status').textContent).toBe('2 campaigns and 1 metric window synced in USD.');
  });
});

describe('BackfillForm and FormMappingForm', () => {
  it('backfill posts the form, the start time as an instant and a request key', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { status: 'QUEUED', created: true }));
    wrap(<BackfillForm workspaceSlug="live-co" forms={['210000000000001']} defaultSince="2026-10-13T11:30" gate={null} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Backfill from form' })));
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as Record<string, string>;
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/app/meta/backfill');
    expect(body.formId).toBe('210000000000001');
    expect(new Date(body.since!).toISOString()).toBe(body.since);
    expect(body.requestKey).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('backfill without a mapped form is gated on configuration', () => {
    wrap(<BackfillForm workspaceSlug="live-co" forms={[]} defaultSince="2026-10-13T11:30" gate={null} />);
    expect(screen.getByRole('button', { name: 'Backfill from form' }).getAttribute('data-gate-category')).toBe('configuration');
  });

  it('form mapping posts the standard keys and the consent question', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { created: true }));
    wrap(<FormMappingForm workspaceSlug="live-co" gate={null} defaultFormId="210000000000009" />);
    fireEvent.change(screen.getByLabelText('Consent question or checkbox key'), { target: { value: 'whatsapp_updates' } });
    fireEvent.change(screen.getByLabelText('Notice text shown on the form'), { target: { value: 'I agree to receive updates on WhatsApp.' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save mapping' })));
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      formId: '210000000000009',
      fields: { name: 'full_name', phone: 'phone_number', email: 'email', city: 'city' },
      consent: { question: 'whatsapp_updates', truthyValues: ['yes'], channel: 'WHATSAPP', purpose: 'MARKETING', noticeText: 'I agree to receive updates on WhatsApp.' },
    });
    expect(screen.getByRole('status').textContent).toBe('Mapping saved for form 210000000000009.');
  });
});
