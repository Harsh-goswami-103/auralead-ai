/**
 * Shell polish pass (design spec §6, §8): the fixes from the design review must hold.
 * - The command palette's "Sign out" option is named exactly "Sign out". It used to carry a fake
 *   shortcut ("session") that leaked into the option's accessible name.
 * - The sidebar names its panel through the nav landmark only. The top bar's lockup shows the
 *   panel title, so the sidebar no longer repeats it as visible text.
 * - global-error.tsx shows the digest and never error.message. Its secondary hover rule carries
 *   !important, because the resting background is an inline style that would otherwise win.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const nav = vi.hoisted(() => ({ pathname: '/dashboard/employee' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { CommandPalette } from '@/components/patterns/CommandPalette';
import { CsrfProvider } from '@/components/patterns/csrf';
import { SidebarNav } from '@/components/patterns/PanelNav';
import GlobalError from '@/app/global-error';

beforeAll(() => {
  // cmdk and Radix measure and scroll items; jsdom implements neither.
  if (!('ResizeObserver' in globalThis)) {
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
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  cleanup();
  nav.pathname = '/dashboard/employee';
});

describe('CommandPalette', () => {
  it('lists the panel sections and a "Sign out" option named exactly that', async () => {
    render(
      <CsrfProvider token="csrf_test">
        <CommandPalette panel="employee" />
      </CsrfProvider>,
    );
    await act(async () => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    });
    const dialog = await screen.findByRole('dialog');
    const options = within(dialog).getAllByRole('option');
    expect(options.map((o) => o.textContent?.trim())).toEqual(['Assignments', 'Approvals', 'Sign out']);
    expect(within(dialog).getByRole('option', { name: 'Sign out' })).toBeTruthy();
    expect(dialog.textContent).not.toContain('session');
  });
});

describe('SidebarNav', () => {
  it('names the panel through the landmark only and marks the current section', () => {
    render(<SidebarNav panel="employee" />);
    const landmark = screen.getByRole('navigation', { name: 'Operator panel' });
    expect(within(landmark).queryByText('Operator panel')).toBeNull();
    expect(within(landmark).getByRole('link', { name: 'Assignments' }).getAttribute('aria-current')).toBe('page');
    expect(within(landmark).getByRole('link', { name: 'Approvals' }).getAttribute('aria-current')).toBeNull();
  });
});

describe('global-error', () => {
  it('shows the digest, never the message, and lets the secondary hover beat its inline background', () => {
    const error = Object.assign(new Error('ECONNREFUSED 127.0.0.1:5432 secret'), { digest: 'dg_77c0' });
    const html = renderToStaticMarkup(<GlobalError error={error} retry={() => undefined} />);
    expect(html).toContain('dg_77c0');
    expect(html).not.toContain('ECONNREFUSED');
    expect(html).toContain('.ge-secondary:hover{background:#1c2333!important}');
    expect(html).toContain('href="/login"');
  });
});
