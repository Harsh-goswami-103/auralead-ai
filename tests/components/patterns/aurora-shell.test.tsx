/**
 * Aurora redesign (design spec §6) of the shell and shared patterns: the new look must keep every
 * contract the old one had, and the fixes must hold.
 * - A gated control looks inert (dashed outline, a lock instead of the caller's icon). Its name is
 *   still exactly the label, and the reason glyph adds no text.
 * - PanelShell mirrors the panel key onto <body> for portaled overlays and clears it on unmount.
 * - EmptyState's decoration is aria-hidden and its heading level is configurable.
 * - ErrorState copies the reference with a real clipboard write and says what happened.
 * - PanelPageSkeleton is one busy status region. PanelRouteError shows an h1, the digest and a
 *   retry, and never the raw error message.
 * - The DEMO persona buttons' names start with the persona label (the e2e contract, /^Workspace
 *   owner/), and the floating switcher is not rendered on /login.
 * - CredentialForm marks fields invalid only when the server rejected them, not on a network
 *   failure (shared report, credential-form.tsx).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));

const nav = vi.hoisted(() => ({ pathname: '/dashboard/user' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState } from '@/components/patterns/ErrorState';
import { GateReason, GatedAction, GATE_CATEGORIES } from '@/components/patterns/GatedAction';
import { PanelPageSkeleton } from '@/components/patterns/PanelPageSkeleton';
import { PanelRouteError } from '@/components/patterns/PanelRouteError';
import { PanelSignature } from '@/components/patterns/PanelSignature';
import { DemoPersonaList, RoleSwitcher, SWITCHER_PERSONAS } from '@/components/patterns/RoleSwitcher';
import { CredentialForm } from '@/app/(auth)/_components/credential-form';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  toastSuccess.mockReset();
  toastError.mockReset();
  nav.pathname = '/dashboard/user';
});

describe('GatedAction look', () => {
  it('renders a gated control inert: dashed outline and a lock instead of the caller icon, name unchanged', () => {
    render(
      <GatedAction
        label="Send by email"
        icon={<svg data-testid="caller-icon" aria-hidden="true" />}
        gate={{ category: 'configuration', reason: 'Email is not configured for this workspace.' }}
        onAction={vi.fn()}
      />,
    );
    const button = screen.getByRole('button', { name: 'Send by email' });
    expect(screen.queryByTestId('caller-icon')).toBeNull();
    const lock = button.querySelector('svg');
    expect(lock).not.toBeNull();
    expect(lock!.getAttribute('aria-hidden')).toBe('true');
    expect(button.className).toContain('border-dashed');
    expect(button.className).toContain('cursor-not-allowed');
    expect(button.className).not.toContain('bg-action');
    expect(button.textContent).toBe('Send by email');
  });

  it('keeps the caller icon and the requested variant when not gated', () => {
    render(<GatedAction label="Send" icon={<svg data-testid="caller-icon" aria-hidden="true" />} gate={null} onAction={vi.fn()} />);
    expect(screen.getByTestId('caller-icon')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' }).className).toContain('bg-action');
  });

  it('gives every category a reason glyph that adds no text', () => {
    for (const category of GATE_CATEGORIES) {
      const { container, unmount } = render(<GateReason id={`r-${category}`} gate={{ category, reason: `Blocked by ${category}.` }} />);
      const reason = container.querySelector(`#r-${category}`)!;
      expect(reason.textContent).toBe(`Blocked by ${category}.`);
      expect(reason.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      unmount();
    }
  });
});

describe('PanelSignature', () => {
  it('mirrors the panel key onto <body> and removes it on unmount', () => {
    const { unmount } = render(<PanelSignature panel="employee" />);
    expect(document.body.dataset.panel).toBe('employee');
    unmount();
    expect(document.body.dataset.panel).toBeUndefined();
  });
});

describe('EmptyState decoration', () => {
  it('hides the orbit motif from assistive tech and honours headingLevel', () => {
    const { container } = render(<EmptyState title="No quotations yet" description="Quotes you create appear here." headingLevel="h3" />);
    expect(screen.getByRole('heading', { level: 3, name: 'No quotations yet' })).toBeTruthy();
    expect(container.querySelector('[data-visual-motion="orbit"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[data-aurora="empty"]')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('ErrorState reference copy', () => {
  it('writes the reference to the clipboard and confirms', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<ErrorState correlationId="req_copy0001" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy reference' }));
    });
    expect(writeText).toHaveBeenCalledWith('req_copy0001');
    expect(toastSuccess).toHaveBeenCalledWith('Reference copied');
  });

  it('says so when the clipboard is unavailable', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    render(<ErrorState correlationId="req_copy0002" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy reference' }));
    });
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe('PanelPageSkeleton', () => {
  it('is a single busy status region with a label and no headings', () => {
    render(<PanelPageSkeleton label="Loading quotations" />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(within(status).getByText('Loading quotations')).toBeTruthy();
    expect(screen.queryAllByRole('heading')).toHaveLength(0);
  });
});

describe('PanelRouteError', () => {
  it('shows an h1, the digest as reference and a retry, never the raw message', () => {
    const retry = vi.fn();
    const error = Object.assign(new Error('SQLITE_CORRUPT at C:\\Users\\secret\\app.db'), { digest: 'dg_4f2a91' });
    const { container } = render(<PanelRouteError panel="admin" error={error} retry={retry} />);
    expect(screen.getByRole('heading', { level: 1, name: 'This page could not be loaded' })).toBeTruthy();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('dg_4f2a91');
    expect(container.textContent).not.toContain('SQLITE_CORRUPT');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('DEMO personas', () => {
  it('names each persona button starting with its label (e2e uses /^Workspace owner/)', () => {
    const { container } = render(<DemoPersonaList />);
    expect(container.querySelector('[data-demo-role-switcher]')).not.toBeNull();
    for (const p of SWITCHER_PERSONAS) {
      expect(screen.getByRole('button', { name: new RegExp(`^${p.label}`) })).toBeTruthy();
    }
  });

  it('keeps the floating trigger named "Demo role ..." on panel routes and omits it on /login', () => {
    nav.pathname = '/dashboard/employee';
    const { container, unmount } = render(<RoleSwitcher />);
    expect(screen.getByRole('button', { name: /^Demo role/ })).toBeTruthy();
    expect(container.querySelector('[data-demo-role-switcher]')).not.toBeNull();
    unmount();
    nav.pathname = '/login';
    const login = render(<RoleSwitcher />);
    expect(login.container.querySelector('[data-demo-role-switcher]')).toBeNull();
  });
});

describe('CredentialForm validity', () => {
  function renderForm() {
    render(
      <CredentialForm
        action="/api/app/auth/login"
        submitLabel="Sign in"
        pendingLabel="Signing in..."
        fields={[
          { name: 'email', label: 'Email', type: 'email', autoComplete: 'username' },
          { name: 'password', label: 'Password', type: 'password', autoComplete: 'current-password' },
        ]}
      />,
    );
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'not-the-password' } });
  }

  it('marks the fields invalid when the server rejects the credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'Email or password is wrong.', reference: 'req_1' }), { status: 401 })));
    renderForm();
    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form')!);
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Email or password is wrong.'));
    expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('Password').getAttribute('aria-invalid')).toBe('true');
  });

  it('does not blame the fields for a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    renderForm();
    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form')!);
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not be reached'));
    expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBeNull();
    expect(screen.getByLabelText('Password').getAttribute('aria-invalid')).toBeNull();
  });
});
