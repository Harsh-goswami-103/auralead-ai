/**
 * T26, R4: the stage controls. The "Move to stage" menu is the keyboard path (Enter opens it, the
 * other stages are menu items, Enter moves); each move posts the stageVersion the page was rendered
 * with, with the CSRF header, and the page re-reads itself afterwards. A 409 (someone moved the lead
 * meanwhile) says so and re-reads instead of pretending; LOST asks for a reason first. On the board,
 * a card dropped on another column moves through the same request; without leads.write there are no
 * menus or drag, and the board says why once.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LeadBoard } from '@/components/leads/LeadBoard';
import { StageMoveMenu } from '@/components/leads/StageMoveMenu';
import type { BoardColumnDto, LeadRowDto } from '@/components/leads/types';
import { CsrfProvider } from '@/components/patterns/csrf';
import { SalesStage } from '@/lib/domain/enums';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

beforeAll(() => {
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
  refresh.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubFetch(response: () => Response) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown>, headers: init.headers as Record<string, string> });
      return response();
    }),
  );
  return calls;
}

const lead = { id: 'lead_1', displayName: 'Asha Raman', salesStage: 'NEW' as const, stageVersion: 3 };

function renderMenu() {
  return render(
    <CsrfProvider token="csrf-stage">
      <StageMoveMenu lead={lead} workspaceSlug="smile-avenue-dental" />
    </CsrfProvider>,
  );
}

async function openMenu() {
  const trigger = screen.getByRole('button', { name: 'Move to stage: Asha Raman' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return screen.findByRole('menu');
}

describe('StageMoveMenu', () => {
  it('opens from the keyboard and offers every other stage', async () => {
    renderMenu();
    const menu = await openMenu();
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Contacted', 'Replied', 'Quote sent', 'Converted', 'Lost']);
    expect(items.every((i) => i.querySelector('svg') !== null)).toBe(true);
    expect(SalesStage).toHaveLength(6);
  });

  it('posts the move with the version it was rendered with, then re-reads the page', async () => {
    const calls = stubFetch(() => json({ changed: true, lead: { id: 'lead_1', salesStage: 'CONTACTED', stageVersion: 4 } }));
    renderMenu();
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Contacted' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/app/leads/lead_1/stage');
    expect(calls[0]!.body).toEqual({ toStage: 'CONTACTED', expectedStageVersion: 3, workspaceSlug: 'smile-avenue-dental' });
    expect(calls[0]!.headers['x-csrf-token']).toBe('csrf-stage');
    expect(toast.success).toHaveBeenCalledWith('Moved Asha Raman to Contacted.');
  });

  it('a stale version (409) is reported and the page re-reads; nothing claims success', async () => {
    stubFetch(() => json({ code: 'STAGE_VERSION_CONFLICT', message: 'This lead changed since you opened it. Reload to see its current stage.', reference: 'req_1' }, 409));
    renderMenu();
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Replied' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error.mock.calls[0]![0]).toBe('This lead changed since you opened it. Reload to see its current stage.');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('LOST asks for a reason first and sends it with the move', async () => {
    const calls = stubFetch(() => json({ changed: true, lead: { id: 'lead_1', salesStage: 'LOST', stageVersion: 4 } }));
    renderMenu();
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Lost' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark Asha Raman as lost' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as lost' }));
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'Write at least 3 characters.');
    expect(calls).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Chose another clinic' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as lost' }));
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ toStage: 'LOST', expectedStageVersion: 3, reason: 'Chose another clinic', workspaceSlug: 'smile-avenue-dental' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

const row = (id: string, stage: LeadRowDto['salesStage'], name: string): LeadRowDto => ({
  id,
  displayName: name,
  city: 'Gurugram',
  category: null,
  phoneE164: null,
  emailNormalized: null,
  firstSource: 'GOOGLE_SHEETS',
  salesStage: stage,
  stageVersion: 0,
  score: stage === 'NEW' ? 64 : null,
  simulated: false,
  createdAt: '2026-10-16T06:00:00.000Z',
  href: `/dashboard/user/leads?lead=${id}`,
});

function columns(): BoardColumnDto[] {
  return SalesStage.map((stage) => ({
    stage,
    rows: stage === 'NEW' ? [row('l1', 'NEW', 'Asha Raman'), row('l2', 'NEW', 'राहुल शर्मा')] : stage === 'REPLIED' ? [row('l3', 'REPLIED', 'Kabir Rao')] : [],
    total: stage === 'NEW' ? { count: 1000, capped: true } : { count: stage === 'REPLIED' ? 1 : 0, capped: false },
  }));
}

function dataTransfer() {
  const data = new Map<string, string>();
  return { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '', effectAllowed: 'all', dropEffect: 'none' };
}

describe('LeadBoard', () => {
  it('one labelled column per stage with its capped count and cards; a column that shows only its first cards says so', () => {
    render(
      <CsrfProvider token="csrf-board">
        <LeadBoard columns={columns()} moveGate={null} tableHref="/dashboard/user/leads" />
      </CsrfProvider>,
    );
    const list = screen.getByRole('list', { name: 'Leads by sales stage' });
    const cols = within(list).getAllByRole('listitem').filter((li) => li.hasAttribute('data-board-column'));
    expect(cols.map((c) => c.getAttribute('data-board-column'))).toEqual([...SalesStage]);
    const newCol = cols[0]!;
    expect(within(newCol).getByRole('heading', { level: 3 }).textContent).toContain('New');
    expect(within(newCol).getByRole('heading', { level: 3 }).textContent).toContain('1,000+');
    expect(within(newCol).getByRole('link', { name: 'राहुल शर्मा' }).getAttribute('href')).toBe('/dashboard/user/leads?lead=l2');
    expect(within(newCol).getAllByText('64 / 100')).toHaveLength(2);
    expect(within(newCol).getByText(/Showing the first 2 of 1,000\+/)).toBeTruthy();
    expect(within(cols[1]!).getByText('No leads in this stage.')).toBeTruthy();
    // Every card has its keyboard path.
    expect(screen.getAllByRole('button', { name: /^Move to stage: / })).toHaveLength(3);
  });

  it('dropping a card on another column moves it with its version; dropping on its own column does nothing', async () => {
    const calls = stubFetch(() => json({ changed: true, lead: { id: 'l1', salesStage: 'QUOTE_SENT', stageVersion: 1 } }));
    const { container } = render(
      <CsrfProvider token="csrf-board">
        <LeadBoard columns={columns()} moveGate={null} tableHref="/dashboard/user/leads" />
      </CsrfProvider>,
    );
    const card = container.querySelector('[data-lead-card="l1"]')!;
    const own = container.querySelector('[data-board-column="NEW"]')!;
    const target = container.querySelector('[data-board-column="QUOTE_SENT"]')!;
    expect(card.getAttribute('draggable')).toBe('true');

    let dt = dataTransfer();
    fireEvent.dragStart(card, { dataTransfer: dt });
    fireEvent.dragOver(own, { dataTransfer: dt });
    fireEvent.drop(own, { dataTransfer: dt });
    expect(calls).toHaveLength(0);

    dt = dataTransfer();
    fireEvent.dragStart(card, { dataTransfer: dt });
    fireEvent.dragOver(target, { dataTransfer: dt });
    expect(target.hasAttribute('data-drop-active')).toBe(true);
    fireEvent.drop(target, { dataTransfer: dt });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe('/api/app/leads/l1/stage');
    expect(calls[0]!.body).toEqual({ toStage: 'QUOTE_SENT', expectedStageVersion: 0 });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('dropping on LOST asks for the reason first', async () => {
    const calls = stubFetch(() => json({ changed: true, lead: { id: 'l3', salesStage: 'LOST', stageVersion: 1 } }));
    const { container } = render(
      <CsrfProvider token="csrf-board">
        <LeadBoard columns={columns()} moveGate={null} tableHref="/dashboard/user/leads" workspaceSlug="smile-avenue-dental" />
      </CsrfProvider>,
    );
    const dt = dataTransfer();
    fireEvent.dragStart(container.querySelector('[data-lead-card="l3"]')!, { dataTransfer: dt });
    fireEvent.dragOver(container.querySelector('[data-board-column="LOST"]')!, { dataTransfer: dt });
    fireEvent.drop(container.querySelector('[data-board-column="LOST"]')!, { dataTransfer: dt });
    const dialog = await screen.findByRole('dialog', { name: 'Mark Kabir Rao as lost' });
    expect(calls).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'No budget this year' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as lost' }));
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ toStage: 'LOST', expectedStageVersion: 0, reason: 'No budget this year', workspaceSlug: 'smile-avenue-dental' });
  });

  it('without leads.write: no menus, no drag, and one gated control that says why', () => {
    const { container } = render(
      <CsrfProvider token="csrf-board">
        <LeadBoard columns={columns()} moveGate={{ category: 'permission', reason: 'Moving leads between stages needs leads.write.' }} tableHref="/dashboard/user/leads" />
      </CsrfProvider>,
    );
    expect(screen.queryAllByRole('button', { name: /^Move to stage: / })).toHaveLength(0);
    expect(container.querySelector('[data-lead-card="l1"]')!.getAttribute('draggable')).toBe('false');
    const gated = screen.getByRole('button', { name: 'Move leads between stages' });
    expect(gated.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('Moving leads between stages needs leads.write.')).toBeTruthy();
  });
});
