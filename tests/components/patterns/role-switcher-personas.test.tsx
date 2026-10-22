/**
 * ADR-126: the DEMO role switcher offers a fourth persona, the Codecraft client (Aarav Mehta,
 * owner of the presentation workspace). Its label never starts with "Workspace owner" (the e2e
 * contract /^Workspace owner/ still names one button), it lands on the client panel, and because
 * two personas share that panel, the route alone marks neither as the current one. Panels with
 * one persona still mark it.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ pathname: '/dashboard/user' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { DemoPersonaList, RoleSwitcher, SWITCHER_PERSONAS } from '@/components/patterns/RoleSwitcher';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  nav.pathname = '/dashboard/user';
});

function stubResizeObserver() {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    },
  );
}

async function openSwitcher(pathname: string) {
  stubResizeObserver();
  nav.pathname = pathname;
  render(<RoleSwitcher />);
  fireEvent.click(screen.getByRole('button', { name: /^Demo role/ }));
  return screen.findByRole('dialog', { name: 'Demo identities' });
}

describe('the Codecraft client persona', () => {
  it('is offered on /login next to the workspace owner, and only one label starts with "Workspace owner"', () => {
    render(<DemoPersonaList />);
    expect(SWITCHER_PERSONAS.map((p) => p.key)).toEqual(['user', 'client', 'employee', 'admin']);
    expect(screen.getAllByRole('button', { name: /^Workspace owner/ })).toHaveLength(1);
    const client = screen.getByRole('button', { name: /^Codecraft client/ });
    expect(client.textContent).toContain('Client panel, Codecraft Web Studio');
    expect(SWITCHER_PERSONAS.find((p) => p.key === 'client')!.home).toBe('/dashboard/user');
  });

  it('marks no persona as current on the client panel, which both client personas share', async () => {
    const dialog = await openSwitcher('/dashboard/user/leads');
    expect(within(dialog).queryAllByRole('button', { current: 'page' })).toHaveLength(0);
    expect(screen.getByRole('button', { name: /^Demo role/ }).textContent).toContain('Choose');
  });

  it('still marks the one persona of the operator panel as current', async () => {
    const dialog = await openSwitcher('/dashboard/employee/codecraft-web');
    const current = within(dialog).getAllByRole('button', { current: 'page' });
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toContain('Employee');
  });
});
