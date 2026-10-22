/**
 * T28 pipeline editor, keyboard path (06-design F13: "Editing has a keyboard path: select node, then
 * menu. Cycle or unsupported-edge rejection shows inline on the offending edge plus a summary"):
 *  - a backward connection is checked by the server; its issues show on that connection and in the
 *    validation summary, in words;
 *  - a stage to itself is refused before anything is sent;
 *  - removing an optional stage reconnects the chain, the server validates it, and Save sends the
 *    version the editor started from and reports "Saved v2, active"; a stale save shows the
 *    server's message;
 *  - policy approval is gated on configuration while auto-send is off;
 *  - without `pipeline.manage` only the read-only list renders.
 * jsdom has no matchMedia, so the canvas is not mounted (the list view and the panel carry the test).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelineEditor, type PipelineEditorProps } from '@/components/pipeline/PipelineEditor';
import { defaultGraph } from '@/components/pipeline/pipeline-model';
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
const bodyOf = (n: number) => JSON.parse(String((fetchMock.mock.calls[n]![1] as RequestInit).body)) as { graph: { stages: Array<{ kind: string }>; edges: Array<{ from: string; to: string }> }; approvalMode: string; expectedVersion?: number; workspaceSlug: string };

const base: PipelineEditorProps = {
  workspaceSlug: 'smile-avenue-dental',
  canEdit: true,
  autoSendEnabled: false,
  baseVersion: 1,
  initialGraph: defaultGraph(),
  initialApprovalMode: 'HUMAN',
  readiness: { DRAFT: { label: 'Local generator (DEMO)', tone: 'demo' } },
};

function renderEditor(props: Partial<PipelineEditorProps> = {}) {
  render(
    <CsrfProvider token="csrf-pipe">
      <PipelineEditor {...base} {...props} />
    </CsrfProvider>,
  );
}

function connectVia(from: string, to: string) {
  fireEvent.change(screen.getByLabelText('From'), { target: { value: from } });
  fireEvent.change(screen.getByLabelText('To'), { target: { value: to } });
  fireEvent.click(screen.getByRole('button', { name: 'Add connection' }));
}

describe('PipelineEditor', () => {
  it('a backward connection shows the server issues on that connection and in the summary', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        ok: false,
        issues: [
          { code: 'CYCLE', message: 'The stages form a loop.' },
          { code: 'STAGE_ORDER', message: 'SCORE cannot come after DRAFT.', edge: { from: 'draft', to: 'score' } },
        ],
      }),
    );
    renderEditor();
    act(() => connectVia('draft', 'score'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/app/pipeline/validate');
    expect(bodyOf(0).graph.edges).toContainEqual({ from: 'draft', to: 'score' });
    expect(bodyOf(0).workspaceSlug).toBe('smile-avenue-dental');

    const edge = await waitFor(() => {
      const el = document.querySelector('[data-edge="draft->score"]');
      if (!el || el.getAttribute('data-edge-error') !== 'true') throw new Error('edge error not shown yet');
      return el as HTMLElement;
    });
    expect(edge.textContent).toContain('Score cannot come after Draft: stages run in their fixed order.');
    expect(edge.textContent).toContain('Part of a loop.');
    const summary = document.querySelector('[data-validation="invalid"]') as HTMLElement;
    expect(summary.textContent).toContain('These connections form a loop.');
    expect(summary.textContent).not.toMatch(/STAGE_ORDER|CYCLE/);
  });

  it('a stage connected to itself is refused before anything is sent', async () => {
    renderEditor();
    act(() => connectVia('draft', 'draft'));
    expect(screen.getByRole('alert').textContent).toBe('Draft cannot connect to itself.');
    await new Promise((r) => setTimeout(r, 400));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('removing Score reconnects the chain; saving sends the base version and reports v2 active', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true, issues: [] }));
    renderEditor();
    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'score' } });
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Remove Score' })));
    expect(document.querySelector('[data-edge="ingestion->draft"]')).not.toBeNull();
    expect(document.querySelector('[data-edge="ingestion->score"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add Score' })).toBeTruthy();
    await waitFor(() => expect(document.querySelector('[data-validation="valid"]')).not.toBeNull(), { timeout: 2000 });
    expect(bodyOf(0).graph.stages.map((s) => s.kind)).toEqual(['INGESTION', 'DRAFT', 'APPROVAL', 'DELIVERY']);

    fetchMock.mockResolvedValueOnce(json(200, { id: 'v2', version: 2, approvalMode: 'HUMAN', active: true }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save as new version' })));
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/app/pipeline/versions');
    expect(bodyOf(1)).toMatchObject({ expectedVersion: 1, approvalMode: 'HUMAN', workspaceSlug: 'smile-avenue-dental' });
    const saved = document.querySelector('[data-saved-version="2"]') as HTMLElement;
    expect(saved.textContent).toContain('Saved v2, active.');
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Save as new version' })).toBeNull();
  });

  it('a stale save shows the server message, not success', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true, issues: [] }));
    renderEditor();
    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'delivery' } });
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Remove Delivery' })));
    await waitFor(() => expect(document.querySelector('[data-validation="valid"]')).not.toBeNull(), { timeout: 2000 });
    fetchMock.mockResolvedValueOnce(json(409, { code: 'PIPELINE_VERSION_CONFLICT', message: 'The pipeline was changed by someone else. Reload to see the current version.', reference: 'req_9' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save as new version' })));
    expect(screen.getByRole('alert').textContent).toContain('changed by someone else');
    expect(document.querySelector('[data-saved-version]')).toBeNull();
  });

  it('policy approval is gated on configuration while auto-send is off', () => {
    renderEditor();
    const policy = screen.getByRole('button', { name: 'Policy approval' });
    expect(policy.getAttribute('aria-disabled')).toBe('true');
    expect(policy.getAttribute('data-gate-category')).toBe('configuration');
    expect(screen.getByText(/needs workspace auto-send to be on/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Human approval' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('without pipeline.manage only the read-only list renders', () => {
    renderEditor({ canEdit: false });
    const list = screen.getByRole('list', { name: 'Pipeline stages in run order' });
    expect(within(list).getAllByRole('listitem').map((li) => li.getAttribute('data-stage-item'))).toEqual(['INGESTION', 'SCORE', 'DRAFT', 'APPROVAL', 'DELIVERY']);
    expect(screen.getByText(/does not include “Manage the pipeline”/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add connection' })).toBeNull();
    expect(screen.getByText('Local generator (DEMO)')).toBeTruthy();
  });
});

/**
 * Adversarial review (ADR-84), finding 1: removing or adding a stage keeps the keyboard panel on a
 * stage that exists. The stage picker moves to a present stage (the one before the removed stage
 * in run order, or the added stage) with its description and controls, and From/To are cleared
 * when they named the removed stage, so "Add connection" asks for a choice instead of answering
 * about a stage that is gone.
 */
describe('PipelineEditor after a stage is removed or added', () => {
  const stageSelect = () => screen.getByLabelText('Stage') as HTMLSelectElement;

  it('the stage picker moves to the stage before the removed one, with its controls', () => {
    fetchMock.mockResolvedValue(json(200, { ok: true, issues: [] }));
    renderEditor();
    fireEvent.change(stageSelect(), { target: { value: 'draft' } });
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Remove Draft' })));
    expect(stageSelect().value).toBe('score');
    expect(within(screen.getByRole('complementary', { name: 'Edit the pipeline with the keyboard' })).getByText(SCORE_DESCRIPTION)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Score' })).toBeTruthy();

    act(() => fireEvent.click(screen.getByRole('button', { name: 'Add Draft' })));
    expect(stageSelect().value).toBe('draft');
    expect(screen.getByRole('button', { name: 'Remove Draft' })).toBeTruthy();
  });

  it('From and To that named the removed stage are cleared, so Add connection asks for a choice', () => {
    fetchMock.mockResolvedValue(json(200, { ok: true, issues: [] }));
    renderEditor();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: 'score' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'approval' } });
    fireEvent.change(stageSelect(), { target: { value: 'score' } });
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Remove Score' })));
    expect((screen.getByLabelText('From') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('To') as HTMLSelectElement).value).toBe('approval');
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Add connection' })));
    expect(screen.getByRole('alert').textContent).toBe('Choose the stage the connection starts from and the stage it leads to.');
  });
});

/**
 * Adversarial review (ADR-84), finding 2: the validation verdict always belongs to the graph on
 * screen. Every edit switches the live region to a neutral "Checking" at once (no "not valid" for a
 * valid edit during the debounce, no earlier "Valid" left next to Save for a graph nobody checked),
 * and Save stays aria-disabled until the server's verdict for the current graph says valid.
 */
describe('PipelineEditor validation verdict', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const live = () => document.querySelector('[role="status"][data-validation]') as HTMLElement;
  const saveButton = () => screen.getByRole('button', { name: 'Save as new version' });

  it('a valid edit is announced as checking, never as not valid, until the server answers', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true, issues: [] }));
    renderEditor();
    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'delivery' } });
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Remove Delivery' })));
    expect(live().getAttribute('data-validation')).toBe('checking');
    expect(live().textContent).toContain('Checking');
    expect(live().textContent).not.toMatch(/not valid/i);
    expect(saveButton().getAttribute('aria-disabled')).toBe('true');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(live().getAttribute('data-validation')).toBe('valid');
    expect(live().textContent).toContain('Valid. Save to make it the active version.');
    expect(saveButton().getAttribute('aria-disabled')).toBeNull();
  });

  it('after a valid verdict, an invalid edit never shows the earlier Valid and keeps Save disabled', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true, issues: [] }));
    renderEditor();
    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'delivery' } });
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Remove Delivery' })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(live().getAttribute('data-validation')).toBe('valid');

    fetchMock.mockResolvedValueOnce(
      json(200, {
        ok: false,
        issues: [
          { code: 'CYCLE', message: 'loop' },
          { code: 'STAGE_ORDER', message: 'order', edge: { from: 'draft', to: 'score' } },
        ],
      }),
    );
    act(() => connectVia('draft', 'score'));
    expect(live().getAttribute('data-validation')).toBe('checking');
    expect(live().textContent).not.toContain('Valid');
    expect(saveButton().getAttribute('aria-disabled')).toBe('true');
    const before = fetchMock.mock.calls.length;
    await act(async () => fireEvent.click(saveButton()));
    expect(fetchMock.mock.calls.length).toBe(before);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(live().getAttribute('data-validation')).toBe('invalid');
    expect(live().textContent).toContain('These connections form a loop.');
    expect(saveButton().getAttribute('aria-disabled')).toBe('true');
  });

  it('an approval mode change is checked too before Save is enabled', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true, issues: [] }));
    renderEditor({ autoSendEnabled: true });
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Policy approval' })));
    expect(live().getAttribute('data-validation')).toBe('checking');
    expect(saveButton().getAttribute('aria-disabled')).toBe('true');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(bodyOf(0).approvalMode).toBe('POLICY_AUTO');
    expect(saveButton().getAttribute('aria-disabled')).toBeNull();
  });
});

const SCORE_DESCRIPTION = 'Checks the website (LIVE only) and gives a heuristic fit score with reasons.';
