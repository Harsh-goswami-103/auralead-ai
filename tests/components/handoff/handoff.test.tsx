/**
 * Lead-gen F5 (ADR-124): the handoff surfaces.
 * - "Hand over to client": the dialog says what will happen (and that no summary is written in
 *   LIVE without AI), takes a note, posts the version the page showed, the note and one request
 *   key per opened dialog with the CSRF header; success says so and re-reads the page; a 409 stays
 *   in the dialog with its reference and re-reads the page. Without leads.handoff it is a gated
 *   control with the reason, and nothing is posted.
 * - The handoff card: status as icon + label, the note, the summary with its provenance (violet
 *   "AI prepared" only for a real model, "Local template" otherwise), the summary status when there
 *   is none, who acknowledged it; the operator reads the read-only state.
 * - Acknowledge posts once with the CSRF header and re-reads the page; a failure says so.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcknowledgeButton } from '@/components/handoff/HandoffActions';
import { HandoffCard } from '@/components/handoff/HandoffCard';
import { ClientHandoff, OperatorHandoff } from '@/components/handoff/HandoffSection';
import { HandOverDialog } from '@/components/handoff/HandOverDialog';
import { CsrfProvider } from '@/components/patterns/csrf';
import type { LeadHandoffDto, LeadHandoffViewDto } from '@/lib/schemas/handoff';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

afterEach(() => {
  cleanup();
  refresh.mockReset();
  toast.success.mockReset();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubFetch(...responses: Array<() => Response>) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown>, headers: init.headers as Record<string, string> });
      const next = responses[Math.min(i, responses.length - 1)]!;
      i += 1;
      return next();
    }),
  );
  return calls;
}

const withCsrf = (el: React.ReactElement) => render(<CsrfProvider token="csrf-token">{el}</CsrfProvider>);

const DIALOG = { leadId: 'lead_1', leadName: 'Mehta Opticals', workspaceSlug: 'codecraft-web', workspaceName: 'Codecraft Web Studio', salesStage: 'REPLIED', stageVersion: 4, summaryAvailable: true, gate: null };

function openDialog(props: Partial<typeof DIALOG> = {}) {
  withCsrf(<HandOverDialog {...DIALOG} {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Hand over to client' }));
  return screen.getByRole('alertdialog');
}

describe('HandOverDialog', () => {
  it('says what will happen, then posts the version, the note and a request key with the CSRF header', async () => {
    const calls = stubFetch(() => json({ handoffId: 'h1', created: true, summaryStatus: 'PENDING', lead: { id: 'lead_1', salesStage: 'CONVERTED', stageVersion: 5, handedOverAt: '2026-10-23T10:00:00.000Z' } }));
    const dialog = openDialog();
    expect(dialog.textContent).toContain('Hand over Mehta Opticals to the client?');
    expect(dialog.textContent).toContain('Workspace: Codecraft Web Studio');
    const effects = within(dialog).getByRole('list', { name: 'What happens' });
    expect(effects.textContent).toContain('The lead moves to Converted.');
    expect(effects.textContent).toContain('AI replies stop');
    expect(effects.textContent).toContain('Message drafts still waiting for approval are withdrawn.');
    expect(effects.textContent).toContain('The automated pipeline stops for this lead.');
    expect(effects.textContent).toContain('A short summary of the conversation is written for the client');
    expect(effects.textContent).toContain('you can no longer message it');

    fireEvent.change(within(dialog).getByLabelText('Note for the client (optional)'), { target: { value: '  Call after 5 pm.  ' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Hand over' }));
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/app/leads/lead_1/handoff');
    expect(calls[0]!.headers['x-csrf-token']).toBe('csrf-token');
    expect(calls[0]!.body).toEqual({ workspaceSlug: 'codecraft-web', expectedStageVersion: 4, note: 'Call after 5 pm.', requestKey: expect.stringMatching(/^handoff-[A-Za-z0-9_-]{8,56}$/) });
    expect(toast.success).toHaveBeenCalledWith('Mehta Opticals was handed over to Codecraft Web Studio.');
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('a 409 stays in the dialog with the message and reference, re-reads the page, and a retry keeps the request key', async () => {
    const calls = stubFetch(() => json({ code: 'ALREADY_HANDED_OVER', message: 'This lead was already handed over to the client.', reference: 'req_conflict01' }, 409));
    const dialog = openDialog({ salesStage: 'CONVERTED' });
    expect(dialog.textContent).toContain('The lead stays in Converted.');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Hand over' }));
    });
    expect(dialog.textContent).toContain('This lead was already handed over to the client.');
    expect(dialog.textContent).toContain('req_conflict01');
    expect(refresh).toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Hand over' }));
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.requestKey).toBe(calls[0]!.body.requestKey);
    expect(calls[0]!.body.note).toBeUndefined();
  });

  it('without an AI integration it says no summary is written', () => {
    const dialog = openDialog({ summaryAvailable: false });
    expect(dialog.textContent).toContain('No AI integration is connected, so no summary is written');
  });

  it('a gate renders the inert control with the reason and posts nothing', () => {
    const calls = stubFetch(() => json({}));
    withCsrf(<HandOverDialog {...DIALOG} gate={{ category: 'permission', reason: 'Handing a lead over needs leads.handoff.' }} />);
    const button = screen.getByRole('button', { name: 'Hand over to client' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('data-gate-category')).toBe('permission');
    fireEvent.click(button);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText('Handing a lead over needs leads.handoff.')).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});

const HANDOFF: LeadHandoffDto = {
  id: 'h1',
  leadId: 'lead_1',
  status: 'HANDED_OVER',
  note: 'Wants a shop website.',
  summary: { asked: 'An online shop.', promised: 'Nothing yet.', nextStep: 'Send a quotation.' },
  summaryStatus: 'READY',
  summaryGeneratorLabel: 'local-deterministic',
  fromUserName: 'Imran Qureshi',
  createdAt: '2026-10-23T10:00:00.000Z',
  acknowledgedAt: null,
  acknowledgedByName: null,
};

const VIOLET = /(?:^|\s)(?:text|bg|border)-ai(?:\/\d+)?(?:\s|$)/;

describe('HandoffCard', () => {
  it('shows the status, who and when, the note and the local summary without the AI style', () => {
    const { container } = render(<HandoffCard handoff={HANDOFF} timeZone="Asia/Kolkata" audience="client" />);
    expect(container.querySelector('[data-handoff-status="HANDED_OVER"]')).toBeTruthy();
    expect(screen.getByText('Handed over')).toBeTruthy();
    expect(container.textContent).toContain('Handed over by Imran Qureshi on');
    expect(container.textContent).toContain('Wants a shop website.');
    expect(screen.getByText('What they asked')).toBeTruthy();
    expect(screen.getByText('An online shop.')).toBeTruthy();
    expect(screen.getByText('Send a quotation.')).toBeTruthy();
    expect(container.textContent).toContain('Local template');
    expect(container.textContent).not.toContain('AI prepared');
    expect([...container.querySelectorAll('*')].some((el) => VIOLET.test(el.getAttribute('class') ?? ''))).toBe(false);
  });

  it('a model-written summary carries the violet AI provenance chip', () => {
    const { container } = render(<HandoffCard handoff={{ ...HANDOFF, summaryGeneratorLabel: 'anthropic' }} timeZone="Asia/Kolkata" audience="client" />);
    const chip = container.querySelector('[data-generator="ai"]');
    expect(chip?.textContent).toContain('AI prepared');
  });

  it('without a summary it shows the summary status and what it means', () => {
    const pending = render(<HandoffCard handoff={{ ...HANDOFF, summary: null, summaryStatus: 'PENDING', summaryGeneratorLabel: null }} timeZone="Asia/Kolkata" audience="client" />);
    expect(pending.container.textContent).toContain('Summary being written');
    pending.unmount();
    const off = render(<HandoffCard handoff={{ ...HANDOFF, summary: null, summaryStatus: 'NOT_CONFIGURED', summaryGeneratorLabel: null }} timeZone="Asia/Kolkata" audience="client" />);
    expect(off.container.textContent).toContain('No AI integration: no summary');
    expect(off.container.textContent).toContain('No AI integration is connected to this workspace');
    off.unmount();
    const failed = render(<HandoffCard handoff={{ ...HANDOFF, summary: null, summaryStatus: 'FAILED', note: null }} timeZone="Asia/Kolkata" audience="operator" />);
    expect(failed.container.textContent).toContain('Summary could not be written');
    expect(failed.container.textContent).toContain('No note was added.');
    expect(failed.container.textContent).toContain('This lead belongs to the client now');
  });

  it('says who acknowledged it', () => {
    const { container } = render(<HandoffCard handoff={{ ...HANDOFF, status: 'ACKNOWLEDGED', acknowledgedAt: '2026-10-23T11:00:00.000Z', acknowledgedByName: 'Aarav Mehta' }} timeZone="Asia/Kolkata" audience="client" />);
    expect(screen.getByText('Acknowledged')).toBeTruthy();
    expect(container.textContent).toContain('Acknowledged by Aarav Mehta on');
  });
});

const VIEW: LeadHandoffViewDto = {
  handoff: HANDOFF,
  lead: { id: 'lead_1', displayName: 'Mehta Opticals', salesStage: 'CONVERTED', stageVersion: 5, handedOverAt: '2026-10-23T10:00:00.000Z', merged: false },
  workspace: { slug: 'codecraft-web', name: 'Codecraft Web Studio' },
  summaryAvailable: false,
  permissions: { canHandOff: false, canAcknowledge: true },
};

describe('the lead page blocks', () => {
  it('the client acknowledges with the CSRF header; the page re-reads itself', async () => {
    const calls = stubFetch(() => json({ handoffId: 'h1', status: 'ACKNOWLEDGED', changed: true }));
    withCsrf(<ClientHandoff view={VIEW} timeZone="Asia/Kolkata" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    });
    expect(calls).toEqual([{ url: '/api/app/handoffs/h1/acknowledge', body: {}, headers: expect.objectContaining({ 'x-csrf-token': 'csrf-token' }) }]);
    expect(toast.success).toHaveBeenCalledWith('You acknowledged Mehta Opticals.');
    expect(refresh).toHaveBeenCalled();
  });

  it('a failed acknowledge says so with its reference', async () => {
    stubFetch(() => json({ code: 'NOT_FOUND', message: 'Not found.', reference: 'req_ack_404' }, 404));
    withCsrf(<AcknowledgeButton handoffId="h9" leadName="Rao Bakery" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    });
    expect(screen.getByRole('alert').textContent).toContain('req_ack_404');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('no Acknowledge once acknowledged or for a viewer who cannot; nothing for a lead never handed over', () => {
    const acked = withCsrf(<ClientHandoff view={{ ...VIEW, handoff: { ...HANDOFF, status: 'ACKNOWLEDGED', acknowledgedAt: '2026-10-23T11:00:00.000Z', acknowledgedByName: 'Aarav Mehta' } }} timeZone="Asia/Kolkata" />);
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    acked.unmount();
    const operatorView = withCsrf(<ClientHandoff view={{ ...VIEW, permissions: { canHandOff: true, canAcknowledge: false } }} timeZone="Asia/Kolkata" />);
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    operatorView.unmount();
    const none = withCsrf(<ClientHandoff view={{ ...VIEW, handoff: null }} timeZone="Asia/Kolkata" />);
    expect(none.container.textContent).toBe('');
  });

  it('the operator block: the dialog before the handoff, gated for a lost lead; the card after', () => {
    const before = withCsrf(<OperatorHandoff view={{ ...VIEW, handoff: null, lead: { ...VIEW.lead, salesStage: 'REPLIED' }, permissions: { canHandOff: true, canAcknowledge: false } }} timeZone="Asia/Kolkata" />);
    expect(screen.getByRole('button', { name: 'Hand over to client' }).getAttribute('aria-disabled')).toBeNull();
    before.unmount();
    const lost = withCsrf(<OperatorHandoff view={{ ...VIEW, handoff: null, lead: { ...VIEW.lead, salesStage: 'LOST' }, permissions: { canHandOff: true, canAcknowledge: false } }} timeZone="Asia/Kolkata" />);
    expect(screen.getByRole('button', { name: 'Hand over to client' }).getAttribute('data-gate-category')).toBe('eligibility');
    expect(lost.container.textContent).toContain('This lead is marked Lost.');
    lost.unmount();
    const after = withCsrf(<OperatorHandoff view={VIEW} timeZone="Asia/Kolkata" />);
    expect(after.container.textContent).toContain('This lead belongs to the client now');
    expect(screen.queryByRole('button', { name: 'Hand over to client' })).toBeNull();
  });
});
