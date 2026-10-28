/**
 * T29 admin panel components:
 *  - OneTimeLink shows an invite or reset link once, names who it is for and when it expires,
 *    copies the exact link, and "Done" drops it;
 *  - AdminFormDialog always asks for a reason, sends the action's body with the reason and the
 *    page's CSRF token, keeps the dialog open with the server's message on a refusal, and on 401
 *    REAUTH_REQUIRED offers the fresh sign-in in place (password in LIVE, persona in DEMO), then
 *    retries with the rotated session's CSRF token;
 *  - the capability picker sets exactly the ticked capabilities, in plan order;
 *  - the workspace form derives the slug from the name and shows the owner link once;
 *  - the invite form sends a workspace only for client users;
 *  - the drilldown view leads with the audited, read-only banner (reason and audit event) and has no
 *    control that changes the workspace;
 *  - roles and account states read as icon + label.
 */
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminFormDialog } from '@/components/admin/AdminFormDialog';
import { CapabilityPicker } from '@/components/admin/CapabilityPicker';
import { CreateWorkspaceForm, slugFromName } from '@/components/admin/CreateWorkspaceForm';
import { DrilldownView, type DrilldownData } from '@/components/admin/DrilldownView';
import { InviteForm } from '@/components/admin/InviteForm';
import { OneTimeLink } from '@/components/admin/OneTimeLink';
import { ROLE_STYLES, USER_STATUS_VOCABULARY } from '@/components/admin/people-vocabulary';
import { RoleChip } from '@/components/admin/RoleChip';
import { StatusChip } from '@/components/admin/StatusChip';
import { CsrfProvider } from '@/components/patterns/csrf';
import type { Capability } from '@/lib/domain/enums';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
const toastSuccess = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn(), info: vi.fn() } }));

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
const calls = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    url: url as string,
    csrf: ((init as RequestInit).headers as Record<string, string>)['x-csrf-token'] ?? null,
    body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
  }));
const withCsrf = (ui: ReactNode) => render(<CsrfProvider token="csrf-page">{ui}</CsrfProvider>);

describe('OneTimeLink', () => {
  it('shows the link once with who it is for and its expiry, copies it exactly, and Done drops it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const onDone = vi.fn();
    render(<OneTimeLink value={{ kind: 'invite', link: 'https://app.example/invite/AbC', expiresAt: '2026-10-18T10:00:00.000Z', email: 'meera@kaveri.example' }} label="Owner invite link" onDone={onDone} />);
    expect(screen.getByRole('heading', { name: /shown only once/ })).toBeTruthy();
    expect((screen.getByLabelText('Owner invite link') as HTMLInputElement).value).toBe('https://app.example/invite/AbC');
    expect((screen.getByLabelText('Owner invite link') as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByText('meera@kaveri.example')).toBeTruthy();
    expect(screen.getByText(/18 Oct 2026/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy owner invite link' })));
    expect(writeText).toHaveBeenCalledWith('https://app.example/invite/AbC');
    fireEvent.click(screen.getByRole('button', { name: 'Done, I have sent it' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('AdminFormDialog', () => {
  function renderDialog(mode: 'live' | 'demo', onSuccess = vi.fn()) {
    withCsrf(
      <AdminFormDialog
        mode={mode}
        triggerLabel="Disable account"
        title="Disable Asha"
        description="They are signed out everywhere."
        confirmLabel="Disable account now"
        endpoint="/api/admin/people/u1/status"
        body={() => ({ status: 'DISABLED' })}
        successMessage={() => 'Account disabled.'}
        onSuccess={onSuccess}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Disable account' }));
    return screen.getByRole('alertdialog');
  }

  it('needs a reason, then sends the body with the reason and the page CSRF token', async () => {
    const onSuccess = vi.fn();
    fetchMock.mockResolvedValueOnce(json(200, { changed: true, status: 'DISABLED', revokedSessions: 2 }));
    const dialog = renderDialog('live', onSuccess);
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Disable account now' })));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('alert').textContent).toContain('at least 5 characters');

    fireEvent.change(within(dialog).getByLabelText('Reason (stored on the audit record)'), { target: { value: 'Left the company' } });
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Disable account now' })));
    expect(calls()).toEqual([{ url: '/api/admin/people/u1/status', csrf: 'csrf-page', body: { status: 'DISABLED', reason: 'Left the company' } }]);
    expect(toastSuccess).toHaveBeenCalledWith('Account disabled.');
    expect(onSuccess).toHaveBeenCalledWith({ changed: true, status: 'DISABLED', revokedSessions: 2 });
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('keeps the dialog open with the server message and reference on a refusal', async () => {
    fetchMock.mockResolvedValueOnce(json(422, { code: 'LAST_ADMIN', message: 'This is the last active administrator.', reference: 'req_42' }));
    const dialog = renderDialog('live');
    fireEvent.change(within(dialog).getByLabelText('Reason (stored on the audit record)'), { target: { value: 'Offboarding' } });
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Disable account now' })));
    const alert = within(dialog).getByRole('alert');
    expect(alert.textContent).toContain('This is the last active administrator.');
    expect(alert.textContent).toContain('req_42');
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('LIVE: a stale sign-in asks for the password in place and retries with the rotated CSRF token', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { code: 'REAUTH_REQUIRED', message: 'Confirm your identity again to continue.' }))
      .mockResolvedValueOnce(json(200, { csrfToken: 'csrf-rotated' }))
      .mockResolvedValueOnce(json(200, { changed: true }));
    const dialog = renderDialog('live');
    fireEvent.change(within(dialog).getByLabelText('Reason (stored on the audit record)'), { target: { value: 'Offboarding' } });
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Disable account now' })));
    expect(within(dialog).getByRole('alert').textContent).toContain('Confirm your identity below');
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: 'my long passphrase' } });
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm password' })));
    expect(refresh).toHaveBeenCalled();
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Disable account now' })));
    const sent = calls();
    expect(sent.map((c) => c.url)).toEqual(['/api/admin/people/u1/status', '/api/app/auth/reauth', '/api/admin/people/u1/status']);
    expect(sent[1]!.body).toEqual({ password: 'my long passphrase' });
    expect(sent[2]!.csrf).toBe('csrf-rotated');
  });

  it('DEMO: the fresh sign-in is the Super admin persona (no password exists)', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { code: 'REAUTH_REQUIRED', message: 'Confirm your identity again to continue.' })).mockResolvedValueOnce(json(200, { csrfToken: 'csrf-demo' }));
    const dialog = renderDialog('demo');
    fireEvent.change(within(dialog).getByLabelText('Reason (stored on the audit record)'), { target: { value: 'Demo walkthrough' } });
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Disable account now' })));
    expect(within(dialog).queryByLabelText('Your password')).toBeNull();
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Sign in again as Super admin (DEMO)' })));
    expect(calls()[1]).toMatchObject({ url: '/api/demo/session', body: { persona: 'admin' } });
  });
});

describe('CapabilityPicker', () => {
  it('ticks and unticks capabilities in plan order; All and None set the group', () => {
    let value: Capability[] = ['leads.read'];
    const onChange = vi.fn((next: Capability[]) => (value = next));
    const { rerender } = render(<CapabilityPicker value={value} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Send/ }));
    expect(value).toEqual(['leads.read', 'dispatch.send']);
    rerender(<CapabilityPicker value={value} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Read leads/ }));
    expect(value).toEqual(['dispatch.send']);
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(value).toHaveLength(20);
    fireEvent.click(screen.getByRole('button', { name: 'None' }));
    expect(value).toEqual([]);
  });
});

describe('CreateWorkspaceForm', () => {
  it('derives the slug from the business name', () => {
    expect(slugFromName('Asha Physio & Rehab, Pune')).toBe('asha-physio-rehab-pune');
    expect(slugFromName('  Café Ñandú  ')).toBe('cafe-nandu');
  });

  it('posts the workspace with the derived slug and shows the owner link once', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        workspace: { id: 'ws_9', slug: 'kaveri-yoga-studio', name: 'Kaveri Yoga Studio' },
        owner: { kind: 'invite', email: 'meera@kaveri.example', inviteId: 'inv_1', link: 'https://app.example/invite/TOKEN', expiresAt: '2026-10-18T10:00:00.000Z' },
      }),
    );
    withCsrf(<CreateWorkspaceForm mode="live" />);
    fireEvent.change(screen.getByLabelText('Business name'), { target: { value: 'Kaveri Yoga Studio' } });
    expect((screen.getByLabelText('Slug') as HTMLInputElement).value).toBe('kaveri-yoga-studio');
    fireEvent.change(screen.getByLabelText('Plan label'), { target: { value: 'Growth' } });
    fireEvent.change(screen.getByLabelText("Owner's email address"), { target: { value: 'meera@kaveri.example' } });
    fireEvent.change(screen.getByLabelText('Reason (stored on the audit record)'), { target: { value: 'Signed order 118' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create workspace' })));
    expect(calls()).toEqual([
      {
        url: '/api/admin/workspaces',
        csrf: 'csrf-page',
        body: { name: 'Kaveri Yoga Studio', slug: 'kaveri-yoga-studio', planLabel: 'Growth', timezone: 'Asia/Kolkata', ownerEmail: 'meera@kaveri.example', reason: 'Signed order 118' },
      },
    ]);
    expect((screen.getByLabelText('Owner invite link') as HTMLInputElement).value).toBe('https://app.example/invite/TOKEN');
    expect(screen.getByRole('status').textContent).toContain('Kaveri Yoga Studio is ready');
    expect(refresh).toHaveBeenCalled();
  });

  it('refuses an invalid slug before calling the server', async () => {
    withCsrf(<CreateWorkspaceForm mode="live" />);
    fireEvent.change(screen.getByLabelText('Business name'), { target: { value: 'Kaveri' } });
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'Bad Slug!' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create workspace' })));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('lowercase letters');
  });
});

describe('InviteForm', () => {
  const workspaces = [{ id: 'ws_1', slug: 'alpha', name: 'Alpha Dental' }];

  it('sends a workspace and membership role only for a client user', async () => {
    fetchMock.mockImplementation(async () => json(200, { invite: { email: 'x@example.test', expiresAt: '2026-10-18T10:00:00.000Z' }, link: 'https://app.example/invite/T', supersededInvites: 0 }));
    withCsrf(<InviteForm mode="live" workspaces={workspaces} />);
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'front.desk@alpha.example' } });
    fireEvent.change(screen.getByLabelText('Role in the workspace'), { target: { value: 'MEMBER' } });
    fireEvent.change(screen.getByLabelText('Reason (stored on the audit record)'), { target: { value: 'Owner asked for a seat' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create invite link' })));
    expect(calls()[0]!.body).toEqual({ email: 'front.desk@alpha.example', globalRole: 'USER', targetWorkspaceId: 'ws_1', membershipRole: 'MEMBER', reason: 'Owner asked for a seat' });
    expect((screen.getByLabelText('Invite link') as HTMLInputElement).value).toBe('https://app.example/invite/T');

    fireEvent.change(screen.getByLabelText('Invite as'), { target: { value: 'EMPLOYEE' } });
    expect(screen.queryByLabelText('Workspace')).toBeNull();
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'ops@example.test' } });
    fireEvent.change(screen.getByLabelText('Reason (stored on the audit record)'), { target: { value: 'New operator' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create invite link' })));
    expect(calls()[1]!.body).toEqual({ email: 'ops@example.test', globalRole: 'EMPLOYEE', reason: 'New operator' });
  });
});

describe('DrilldownView', () => {
  const data: DrilldownData = {
    audit: { eventId: 'audit_123', reason: 'Support ticket 4411', openedAt: '2026-10-15T10:00:00.000Z' },
    workspace: { id: 'ws_1', slug: 'alpha', name: 'Alpha Dental', planLabel: 'Growth', timezone: 'Asia/Kolkata', status: 'ACTIVE', mode: 'LIVE', automationPaused: false, automationPauseReason: null, createdAt: '2026-01-01T00:00:00.000Z' },
    settings: { taxMode: 'CONFIGURED', taxLabel: 'GST', taxBps: 1800, maxDiscountBps: 1000, quoteValidityDays: 15, autoSendEnabled: false, emailFallbackEnabled: true, emailB2bAttestationEnabled: false, bookingLinkSet: true, gstinSet: false, internalWaDailyCap: null, internalEmailDailyCap: null },
    configuration: { pricingVersion: 2, services: 4, pricedServices: 3, scoringVersion: 1, pipelineVersion: 1, approvalMode: 'HUMAN' },
    leads: { total: 7, byStage: { NEW: 5, QUOTE_SENT: 2 } },
    quotes: { total: 2, byStatus: { SENT: 2 } },
    approvalsPending: 1,
    openConversations: 3,
    activeSuppressions: 0,
    integrations: [{ kind: 'WHATSAPP_CLOUD', status: 'CONNECTED', lastCheckedAt: null, verifiedAt: null }],
    jobs: { SUCCEEDED: 12 },
    recentActivity: [{ id: 'a1', action: 'admin.elevate', actorKind: 'SUPER_ADMIN', result: 'SUCCESS', crossWorkspace: true, createdAt: '2026-10-15T10:00:00.000Z' }],
  };

  it('leads with the audited, read-only banner and offers no control that changes the workspace', () => {
    const onClose = vi.fn();
    render(<DrilldownView data={data} onClose={onClose} />);
    const banner = screen.getByRole('note', { name: 'Audited view' });
    expect(banner.textContent).toContain('Audited view of Alpha Dental: read-only');
    expect(banner.textContent).toContain('Support ticket 4411');
    expect(banner.textContent).toContain('audit_123');
    expect(screen.getByText('Quote sent').parentElement?.textContent).toBe('Quote sent2');
    expect(screen.getByText('New').parentElement?.textContent).toBe('New5');
    expect(screen.getByText('v2 · 3 of 4 services priced')).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
    const buttons = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(buttons.sort()).toEqual(['Close the view', 'Copy audit event id'].sort());
    expect(document.querySelector('form, input, textarea, select')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close the view' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('role and account status chips', () => {
  it('read as icon plus label, never color alone', () => {
    render(
      <>
        <RoleChip role="EMPLOYEE" />
        <StatusChip entry={USER_STATUS_VOCABULARY.DISABLED} state="DISABLED" />
      </>,
    );
    const role = document.querySelector('[data-role-chip="EMPLOYEE"]')!;
    expect(role.textContent).toBe(ROLE_STYLES.EMPLOYEE.label);
    expect(role.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    const status = document.querySelector('[data-status-chip="DISABLED"]')!;
    expect(status.textContent).toBe('Disabled');
    expect(status.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });
});
