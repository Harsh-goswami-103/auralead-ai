/**
 * T28 source page controls (R11, AT2 UI path; ADR-17): the simulator posts the chosen record count
 * and the workspace slug to the DEMO simulation route and re-reads the page; LIVE gates it on mode
 * and a missing `leads.write` on permission (focusable, reason visible, nothing sent); while a
 * delivery is queued it says the page updates by itself. Sync templates posts to the WhatsApp
 * route and reports what was added as simulated; LIVE without a connected WhatsApp is gated on
 * configuration with the setup link. The section tabs mark the current section.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceSimulator } from '@/components/integrations/SourceSimulator';
import { TemplateSyncButton } from '@/components/integrations/TemplateSyncButton';
import { templateSyncGate, simulationGateOf } from '@/components/integrations/vocabulary';
import { WORKSPACE_SECTIONS } from '@/components/integrations/sections';
import { WorkspaceSectionNav } from '@/components/integrations/WorkspaceSectionNav';
import { CsrfProvider } from '@/components/patterns/csrf';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }), usePathname: () => '/dashboard/employee/smile-avenue-dental/sheets' }));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const wrap = (node: ReactNode) => render(<CsrfProvider token="csrf-src">{node}</CsrfProvider>);

describe('SourceSimulator', () => {
  it('posts the record count and slug, reports the simulated delivery and re-reads the page', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { records: 2, events: [{ outcome: 'ACCEPTED' }] }));
    wrap(<SourceSimulator source="sheets" workspaceSlug="smile-avenue-dental" gate={null} pending={false} description="Pushes simulated rows." />);
    fireEvent.change(screen.getByLabelText('Records'), { target: { value: '2' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Simulate' })));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/demo/simulate/sheets');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ workspaceSlug: 'smile-avenue-dental', count: 2 });
    expect(toastSuccess.mock.calls[0]![0]).toBe('2 simulated form rows received.');
    expect(refresh).toHaveBeenCalled();
  });

  it('LIVE: gated on mode with the reason, nothing sent', async () => {
    const gate = simulationGateOf({ allowed: false, category: 'mode', reason: 'Simulations run only in DEMO mode.' });
    wrap(<SourceSimulator source="meta" workspaceSlug="live-co" gate={gate} pending={false} description="Simulated leads." />);
    const button = screen.getByRole('button', { name: 'Simulate' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('data-gate-category')).toBe('mode');
    expect(screen.getByText('Simulations run only in DEMO mode.')).toBeTruthy();
    await act(async () => fireEvent.click(button));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a refusal is shown as an error, and a queued delivery says the page updates', async () => {
    fetchMock.mockResolvedValueOnce(json(403, { code: 'FORBIDDEN', message: 'You do not have permission.', reference: 'req_7' }));
    wrap(<SourceSimulator source="gmaps" workspaceSlug="smile-avenue-dental" gate={null} pending description="Simulated batch." />);
    expect(screen.getByRole('status').textContent).toContain('This page updates by itself');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Simulate' })));
    expect(toastError).toHaveBeenCalledWith('You do not have permission.', { description: 'Reference req_7' });
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe('TemplateSyncButton', () => {
  it('DEMO: syncs and says what was added, labelled simulated', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { simulated: true, created: 4, existing: 0, updated: 0 }));
    wrap(<TemplateSyncButton workspaceSlug="smile-avenue-dental" gate={templateSyncGate({ mode: 'demo', canManage: true, status: 'NOT_CONFIGURED', setupHref: '/x' })} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sync templates' })));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/app/integrations/whatsapp/templates/sync');
    expect(screen.getByRole('status').textContent).toBe('4 templates added, 0 already synced. Simulated, no provider contacted.');
    expect(refresh).toHaveBeenCalled();
  });

  it('LIVE without a connected WhatsApp: gated on configuration with the setup link', async () => {
    wrap(<TemplateSyncButton workspaceSlug="live-co" gate={templateSyncGate({ mode: 'live', canManage: true, status: 'CONFIGURED_UNVERIFIED', setupHref: '/dashboard/employee/live-co/integrations/whatsapp' })} />);
    const button = screen.getByRole('button', { name: 'Sync templates' });
    expect(button.getAttribute('data-gate-category')).toBe('configuration');
    expect(screen.getByRole('link', { name: /Open WhatsApp setup/ }).getAttribute('href')).toBe('/dashboard/employee/live-co/integrations/whatsapp');
    await act(async () => fireEvent.click(button));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('WorkspaceSectionNav', () => {
  it('links every workspace section and marks the current one', () => {
    render(<WorkspaceSectionNav slug="smile-avenue-dental" workspaceName="Smile Avenue Dental Clinic" />);
    const nav = screen.getByRole('navigation', { name: 'Smile Avenue Dental Clinic sections' });
    const links = nav.querySelectorAll('a');
    // Every section of WORKSPACE_SECTIONS, in its order (the lead-gen slices add theirs: Inbox, ...).
    expect([...links].map((a) => a.textContent)).toEqual(WORKSPACE_SECTIONS.map((s) => s.label));
    for (const label of ['Leads', 'Approvals', 'Integrations', 'Pipeline', 'Sheets', 'Meta', 'Extension', 'Lead finder', 'Templates', 'Inbox']) expect(screen.getByRole('link', { name: label })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sheets' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Leads' }).getAttribute('aria-current')).toBeNull();
  });
});
