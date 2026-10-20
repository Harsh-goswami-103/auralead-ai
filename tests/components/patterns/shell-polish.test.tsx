/**
 * Shell polish pass (design spec §6, §8): the fixes from the design review must hold.
 * - The command palette's "Sign out" option is named exactly "Sign out". It used to carry a fake
 *   shortcut ("session") that leaked into the option's accessible name.
 * - The sidebar names its panel through the nav landmark only. The top bar's lockup shows the
 *   panel title, so the sidebar no longer repeats it as visible text.
 * - global-error.tsx shows the digest and never error.message. Its secondary hover rule carries
 *   !important, because the resting background is an inline style that would otherwise win.
 * - Closing the command palette returns focus to where it was when the palette opened (it has no
 *   Radix trigger, so focus used to drop to <body>), and Ctrl/Cmd+K while open does not re-record it.
 * - The top bar's controls are named starting with what they show (WCAG 2.5.3): the brand link
 *   "AuraLead <panel> home", the workspace switcher from its visible text, the account trigger
 *   from its initials. The small ones keep a 44px hit area below lg, positioned so it stays on
 *   the control, and so do Input and NativeSelect (spec §0.5).
 * - On panel pages the page scroll stops clear of the sticky top bar (and of the bottom tab bar
 *   below lg), so a focused control is never hidden under them.
 * - Opening the mobile "More" sheet focuses the current section (or the first section), never the
 *   destructive "Sign out" (Radix skips links when it picks the first focusable).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const nav = vi.hoisted(() => ({ pathname: '/dashboard/employee' }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useParams: () => ({}),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { CommandPalette } from '@/components/patterns/CommandPalette';
import { CsrfProvider } from '@/components/patterns/csrf';
import { BottomTabs, SidebarNav } from '@/components/patterns/PanelNav';
import { PanelShell } from '@/components/patterns/PanelShell';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import GlobalError from '@/app/global-error';
import type { PanelChrome } from '@/server/services/shell/panel-chrome';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

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

describe('CommandPalette focus return', () => {
  function renderPalette() {
    render(
      <CsrfProvider token="csrf_test">
        <button type="button">Retry job</button>
        <CommandPalette panel="employee" />
      </CsrfProvider>,
    );
    return { trigger: document.querySelector<HTMLButtonElement>('button[aria-keyshortcuts]')!, retry: screen.getByRole('button', { name: 'Retry job' }) };
  }
  async function pressInPalette(init: { key: string; ctrlKey?: boolean }) {
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, init);
    });
  }

  it('returns focus to the trigger when closed with Escape after opening it by click', async () => {
    const { trigger } = renderPalette();
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole('dialog');
    await waitFor(() => expect(document.activeElement).not.toBe(trigger));
    await pressInPalette({ key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('returns focus to the element that had it when Ctrl+K opened the palette, also when Ctrl+K closes it', async () => {
    const { retry } = renderPalette();
    for (const close of [{ key: 'Escape' }, { key: 'k', ctrlKey: true }]) {
      retry.focus();
      await pressInPalette({ key: 'k', ctrlKey: true });
      await screen.findByRole('dialog');
      await waitFor(() => expect(document.activeElement).not.toBe(retry));
      await pressInPalette(close);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(retry));
    }
  });
});

describe('PanelShell top bar', () => {
  const kesari = { slug: 'kesari-crafts', name: 'Kesari Crafts Online', planLabel: 'Starter', mode: 'DEMO' } as const;
  const chrome: PanelChrome = {
    mode: 'demo',
    user: { name: 'Ishaan Qureshi', email: 'ishaan@example.test', role: 'EMPLOYEE', isDemo: true },
    workspace: kesari,
    switchable: [kesari, { slug: 'smile-avenue', name: 'Smile Avenue Dental Clinic', planLabel: 'Growth', mode: 'DEMO' }],
    outboundPaused: false,
    automationPaused: false,
  };
  const hitArea = 'max-lg:before:min-h-11';

  it('names each control starting with the words it shows, and gives the small ones a positioned 44px hit area', () => {
    render(
      <PanelShell panel="employee" chrome={chrome} csrfToken="csrf_test">
        <p>Page</p>
      </PanelShell>,
    );
    const home = screen.getByRole('link', { name: 'AuraLead Operator panel home' });
    // The lockup's two lines are separate words ("AuraLead Operator panel"), not "AuraLeadOperator panel".
    expect(home.textContent).toBe('AuraLead Operator panel');
    expect(home.getAttribute('aria-label')!.startsWith(home.textContent!)).toBe(true);

    const chip = screen.getByRole('button', { name: 'Workspace: Kesari Crafts Online Starter Demo. Switch workspace' });
    expect(chip.hasAttribute('aria-label')).toBe(false);

    expect(screen.getByRole('button', { name: 'IQ, account: Ishaan Qureshi' })).toBeTruthy();

    // Without `relative` the ::before would be absolute to the sticky header and span all of it.
    for (const control of [home, chip, document.querySelector<HTMLElement>('button[aria-keyshortcuts]')!]) {
      expect(control.classList.contains('relative')).toBe(true);
      expect(control.classList.contains(hitArea)).toBe(true);
    }
  });

  it('makes Input and NativeSelect 44px tall below lg', () => {
    render(
      <>
        <Input aria-label="Name" />
        <NativeSelect aria-label="Status">
          <option>Any</option>
        </NativeSelect>
      </>,
    );
    expect(screen.getByRole('textbox', { name: 'Name' }).classList.contains('max-lg:h-11')).toBe(true);
    expect(screen.getByRole('combobox', { name: 'Status' }).classList.contains('max-lg:h-11')).toBe(true);
  });

  it('keeps the page scroll clear of the sticky top bar and, below lg, of the bottom tab bar', () => {
    const css = readFileSync(path.join(repoRoot, 'src/app/globals.css'), 'utf8').replace(/\s+/g, ' ');
    expect(css).toContain('html:has([data-panel]) { scroll-padding-top: calc(var(--topbar-h) + 0.5rem); }');
    expect(css).toMatch(/@media \(width < 64rem\) \{ html:has\(\[data-panel\]\) \{ scroll-padding-bottom: /);
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

describe('BottomTabs "More" sheet', () => {
  async function openMore() {
    render(
      <CsrfProvider token="csrf_test">
        <BottomTabs panel="employee" />
      </CsrfProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    return screen.findByRole('dialog');
  }

  it('focuses the current section link when it opens, not "Sign out"', async () => {
    nav.pathname = '/dashboard/employee/approvals';
    const sheet = await openMore();
    const current = within(sheet).getByRole('link', { name: 'Approvals' });
    expect(current.getAttribute('aria-current')).toBe('page');
    await waitFor(() => expect(document.activeElement).toBe(current));
    expect(document.activeElement).not.toBe(within(sheet).getByRole('button', { name: 'Sign out' }));
  });

  it('focuses the first section link when no section is current', async () => {
    nav.pathname = '/dashboard/employee/elsewhere';
    const sheet = await openMore();
    await waitFor(() => expect(document.activeElement).toBe(within(sheet).getByRole('link', { name: 'Assignments' })));
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
