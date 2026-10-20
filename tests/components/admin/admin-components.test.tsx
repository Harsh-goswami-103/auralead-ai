/**
 * Platform admin components (design spec §0, §6): the JSON viewer renders tokens as text (no raw
 * HTML), keeps the redaction marker, collapses with native disclosures and copies the exact JSON;
 * the outbound pause shows the same three switches as the jobs page (a hand-made outbound.lock
 * reads as paused) with icon + label chips, as a list or as switch cards; the status vocabulary
 * keeps the server's labels and never relies on color; the metric tile stays a valid
 * `dl > div > dt + dd` group; the scroll fade shows only while more content is below; section
 * titles keep the heading's name to its text; the lifecycle rail names every step in text.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DISPATCH_STATE_VOCABULARY,
  JOB_STATUS_VOCABULARY,
  PROVIDER_STYLES,
  WEBHOOK_STATUS_VOCABULARY,
  attemptOutcomeEntry,
  formatAge,
  jobStatusEntry,
} from '@/components/admin/admin-vocabulary';
import { InlineEmpty } from '@/components/admin/InlineEmpty';
import { JobLifecycle } from '@/components/admin/JobLifecycle';
import { JsonView } from '@/components/admin/JsonView';
import { MetricTile } from '@/components/admin/MetricTile';
import { OutboundSources, OutboundStateChip, pauseSources } from '@/components/admin/OutboundState';
import { ScrollRegion } from '@/components/admin/ScrollRegion';
import { SectionTitle } from '@/components/admin/SectionTitle';
import { StatusChip } from '@/components/admin/StatusChip';
import { DispatchState, JobStatus, WebhookProvider, WebhookStatus } from '@/lib/domain/enums';
import type { OutboundPauseState } from '@/server/services/admin/outbound-pause';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function pauseState(over: { db?: boolean; lock?: boolean; restore?: boolean; env?: boolean } = {}): OutboundPauseState {
  const db = over.db ?? false;
  const lock = over.lock ?? false;
  const env = over.env ?? false;
  return {
    paused: db || lock || env,
    db: { paused: db, at: db ? new Date('2026-10-19T10:00:00.000Z') : null, by: db ? 'admin' : null, reason: db ? 'Provider incident' : null },
    lockFile: {
      present: lock,
      writtenByRestore: Boolean(over.restore),
      content: over.restore ? { writtenBy: 'db:restore', at: '2026-10-19T10:00:00.000Z', reason: 'restore' } : null,
      path: '/data/demo/outbound.lock',
    },
    env: { paused: env },
  };
}

describe('JsonView', () => {
  const value = { kind: 'wa.message', count: 3, ok: true, none: null, token: 'Bearer [REDACTED]', nested: { deep: { deeper: { deepest: 1 } } }, list: [] };

  it('renders every token as text with its category, never as raw HTML', () => {
    const { container } = render(<JsonView value={value} label="payload.json" redacted />);
    const region = screen.getByRole('region', { name: 'payload.json contents' });
    expect(region.textContent).toContain('"kind": "wa.message",');
    expect(region.textContent).toContain('"count": 3,');
    expect(region.textContent).toContain('"ok": true,');
    expect(region.textContent).toContain('"none": null,');
    expect(region.textContent).toContain('"list": []');
    // The redaction marker stays readable as text and is set apart.
    const marker = container.querySelector('[data-json-redacted]');
    expect(marker?.textContent).toBe('[REDACTED]');
    expect(screen.getByText('Redacted')).toBeTruthy();
    expect(screen.getByText(/B · \d+ lines/)).toBeTruthy();
  });

  it('collapses objects with native disclosures, deeper levels closed with a size preview', () => {
    const { container } = render(<JsonView value={value} label="payload.json" openDepth={2} />);
    const details = [...container.querySelectorAll('details')];
    // root, nested, deep, deeper
    expect(details).toHaveLength(4);
    expect(details.map((d) => d.open)).toEqual([true, true, false, false]);
    const deep = details[2]!;
    expect(within(deep.querySelector('summary')!).getByText('1 key')).toBeTruthy();
  });

  it('copies the exact pretty-printed JSON', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<JsonView value={{ a: 1 }} label="result.json" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy result.json' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(JSON.stringify({ a: 1 }, null, 2)));
  });
});

describe('Outbound pause state', () => {
  it('reads a hand-made outbound.lock as paused, naming the lock as the only source', () => {
    const state = pauseState({ lock: true });
    expect(pauseSources(state)).toEqual(['outbound.lock']);
    const { container } = render(
      <>
        <OutboundStateChip paused={state.paused} />
        <OutboundSources state={state} detailed />
      </>,
    );
    const chip = container.querySelector('[data-status-chip="paused"]')!;
    expect(chip.textContent).toBe('Paused');
    expect(chip.getAttribute('data-tone')).toBe('danger');
    expect(chip.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    const lock = container.querySelector('[data-pause-source="lock"]')!;
    expect(lock.getAttribute('data-on')).toBe('true');
    expect(within(lock as HTMLElement).getByText('Present')).toBeTruthy();
    expect(within(lock as HTMLElement).getByText(/remove the file to lift it/)).toBeTruthy();
    expect(container.querySelector('[data-pause-source="db"]')!.getAttribute('data-on')).toBe('false');
    expect(container.querySelector('[data-pause-source="env"]')!.getAttribute('data-on')).toBe('false');
  });

  it('names every active source and shows "Not paused" in the success tone when none is on', () => {
    expect(pauseSources(pauseState({ db: true, lock: true, restore: true, env: true }))).toEqual([
      'the admin switch',
      'outbound.lock (from a restore)',
      'the OUTBOUND_PAUSED flag',
    ]);
    const { container } = render(
      <>
        <OutboundStateChip paused={false} />
        <OutboundSources state={pauseState()} />
      </>,
    );
    const chip = container.querySelector('[data-status-chip="not-paused"]')!;
    expect(chip.textContent).toBe('Not paused');
    expect(chip.getAttribute('data-tone')).toBe('success');
    // The admin home reserves the exact word "Running" for the worker state.
    expect(screen.queryByText('Running', { exact: true })).toBeNull();
  });
});

describe('admin status vocabulary', () => {
  it('covers every job status, dispatch state, webhook status and provider', () => {
    expect(Object.keys(JOB_STATUS_VOCABULARY).sort()).toEqual([...JobStatus].sort());
    expect(Object.keys(DISPATCH_STATE_VOCABULARY).sort()).toEqual([...DispatchState].sort());
    expect(Object.keys(WEBHOOK_STATUS_VOCABULARY).sort()).toEqual([...WebhookStatus].sort());
    expect(Object.keys(PROVIDER_STYLES).sort()).toEqual([...WebhookProvider].sort());
    for (const provider of WebhookProvider) expect(PROVIDER_STYLES[provider].label).not.toBe(provider);
  });

  it("keeps the server's job labels and picks the tone from the real state", () => {
    expect(jobStatusEntry({ status: 'QUEUED', label: 'Retry waiting', attempts: 2 })).toMatchObject({ label: 'Retry waiting', tone: 'warning' });
    expect(jobStatusEntry({ status: 'QUEUED', label: 'Retry waiting', attempts: 0 })).toMatchObject({ label: 'Retry waiting', tone: 'info' });
    expect(jobStatusEntry({ status: 'RUNNING', label: 'Running (cancel requested)', attempts: 1 })).toMatchObject({ label: 'Running (cancel requested)', tone: 'warning' });
    expect(jobStatusEntry({ status: 'DEAD', label: 'Dead: delivery unknown', attempts: 5 })).toMatchObject({ label: 'Dead: delivery unknown', tone: 'warning' });
    expect(jobStatusEntry({ status: 'DEAD', label: 'Dead: PERMANENT', attempts: 5 })).toMatchObject({ label: 'Dead: PERMANENT', tone: 'danger' });
    expect(DISPATCH_STATE_VOCABULARY.AMBIGUOUS.label).toBe('Delivery unknown');
    expect(attemptOutcomeEntry(null).label).toBe('In flight');
    expect(attemptOutcomeEntry('FATAL').tone).toBe('danger');
    // A no-break space keeps the number with its unit when a tile's hint wraps.
    expect(formatAge(4_000)).toBe('4\u00a0s');
    expect(formatAge(5 * 60_000)).toBe('5\u00a0min');
  });

  it('renders a chip as icon + text label', () => {
    const { container } = render(<StatusChip entry={JOB_STATUS_VOCABULARY.SUCCEEDED} state="SUCCEEDED" />);
    const chip = container.querySelector('[data-status-chip="SUCCEEDED"]')!;
    expect(chip.textContent).toBe('Succeeded');
    expect(chip.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('MetricTile', () => {
  it('is a dl > div group holding only its dt and dd elements', () => {
    const { container } = render(
      <dl>
        <MetricTile label="Workspaces" value="5" hint="5 active, 0 suspended" icon={<svg />} hue="client" index={0} />
      </dl>,
    );
    const group = container.querySelector('dl > div')!;
    expect([...group.children].map((c) => c.tagName)).toEqual(['DT', 'DD', 'DD']);
    expect(within(group as HTMLElement).getByText('Workspaces', { exact: true })).toBeTruthy();
    expect(within(group as HTMLElement).getByText('5', { exact: true }).tagName).toBe('DD');
  });
});

describe('OutboundSources as switch cards', () => {
  it('keeps the same switches, states and details in the grid layout', () => {
    const { container } = render(<OutboundSources state={pauseState({ env: true })} detailed layout="grid" />);
    const cards = [...container.querySelectorAll('[data-pause-source]')];
    expect(cards.map((c) => [c.getAttribute('data-pause-source'), c.getAttribute('data-on')])).toEqual([
      ['db', 'false'],
      ['lock', 'false'],
      ['env', 'true'],
    ]);
    const env = cards[2] as HTMLElement;
    expect(within(env).getByText('OUTBOUND_PAUSED flag')).toBeTruthy();
    expect(within(env).getByText('Set').closest('[data-status-chip]')?.getAttribute('data-tone')).toBe('danger');
    expect(within(env).getByText(/restart without it to lift/)).toBeTruthy();
    expect(within(cards[1] as HTMLElement).getByText('Absent')).toBeTruthy();
  });
});

describe('ScrollRegion', () => {
  function setBox(el: HTMLElement, box: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
    Object.defineProperty(el, 'scrollHeight', { value: box.scrollHeight, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: box.clientHeight, configurable: true });
    Object.defineProperty(el, 'scrollTop', { value: box.scrollTop, configurable: true, writable: true });
  }

  it('is a focusable labelled region whose fade shows only while more content is below', () => {
    render(
      <ScrollRegion label="Jobs table">
        <p>rows</p>
      </ScrollRegion>,
    );
    const region = screen.getByRole('region', { name: 'Jobs table' });
    expect(region.getAttribute('tabindex')).toBe('0');
    const wrapper = region.parentElement!;
    // Content that fits: no fade.
    expect(wrapper.getAttribute('data-more')).toBe('false');
    setBox(region, { scrollHeight: 900, clientHeight: 300, scrollTop: 0 });
    fireEvent.scroll(region);
    expect(wrapper.getAttribute('data-more')).toBe('true');
    setBox(region, { scrollHeight: 900, clientHeight: 300, scrollTop: 600 });
    fireEvent.scroll(region);
    expect(wrapper.getAttribute('data-more')).toBe('false');
    // The fade itself is decorative.
    expect(wrapper.lastElementChild?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('SectionTitle and InlineEmpty', () => {
  it('keeps the heading name to its text and hides the icon chip', () => {
    render(
      <h2>
        <SectionTitle icon={<svg data-testid="icon" />} hue="volt">
          Worker
        </SectionTitle>
      </h2>,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Worker' })).toBeTruthy();
    expect(screen.getByTestId('icon').parentElement?.getAttribute('aria-hidden')).toBe('true');
  });

  it('says what is empty in plain text', () => {
    const { container } = render(<InlineEmpty icon={<svg />}>The job has not run yet.</InlineEmpty>);
    expect(container.textContent).toBe('The job has not run yet.');
    expect(container.querySelector('[aria-hidden="true"] svg')).toBeTruthy();
  });
});

describe('JobLifecycle', () => {
  const at = new Date('2026-10-19T10:00:00.000Z');

  it('names every step and its state in text, marking the current step', () => {
    render(
      <JobLifecycle job={{ status: 'SUCCEEDED', entry: jobStatusEntry({ status: 'SUCCEEDED', label: 'Succeeded', attempts: 1 }), createdAt: at, runAt: at, startedAt: at, finishedAt: at }} />,
    );
    const steps = within(screen.getByRole('list', { name: 'Job lifecycle' })).getAllByRole('listitem');
    expect(steps.map((li) => li.getAttribute('aria-current'))).toEqual([null, null, 'step']);
    expect(steps[0]!.textContent).toContain('Queued');
    expect(steps[0]!.textContent).toContain('Done');
    expect(steps[2]!.textContent).toContain('Succeeded');
    expect(steps[2]!.textContent).toContain('Current');
  });

  it('marks a step the job never reached', () => {
    render(
      <JobLifecycle job={{ status: 'CANCELLED', entry: jobStatusEntry({ status: 'CANCELLED', label: 'Cancelled', attempts: 0 }), createdAt: at, runAt: at, startedAt: null, finishedAt: at }} />,
    );
    const steps = within(screen.getByRole('list', { name: 'Job lifecycle' })).getAllByRole('listitem');
    expect(steps[1]!.textContent).toContain('Not reached');
    expect(steps[2]!.textContent).toContain('Cancelled');
  });
});
