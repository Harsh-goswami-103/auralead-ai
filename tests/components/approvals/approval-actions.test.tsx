/**
 * T22 approval actions (06-design F18, §11.3 "Approvals queue", AT12 at the UI): approve and
 * approve-and-send bind the version on screen and the workspace slug; a stale item (409) shows
 * "This item changed since you opened it" and does not report success; approve-and-send runs once
 * on a double click; a channel the server says cannot be used is gated with its reason; reject asks
 * for a reason; without the capability every decision is gated by permission.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import { ApprovalActions, type ApprovalActionsProps } from '@/components/approvals/ApprovalActions';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
const toastSuccess = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn() } }));

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

const base: ApprovalActionsProps = {
  approvalId: 'appr_1',
  workspaceSlug: 'smile-avenue-dental',
  workspaceName: 'Smile Avenue Dental Clinic',
  kind: 'QUOTE_VERSION',
  status: 'PENDING',
  label: 'Q-0003 v2',
  versionNo: 2,
  isCurrent: true,
  pdfReady: true,
  channels: [
    { channel: 'EMAIL', gate: null, templates: [], deferredLabels: [] },
    { channel: 'WHATSAPP', gate: { category: 'configuration', reason: 'No approved WhatsApp template is synced.' }, templates: [], deferredLabels: [] },
  ],
  permissions: { canDecide: true, canSend: true },
};

function renderActions(props: Partial<ApprovalActionsProps> = {}) {
  render(
    <CsrfProvider token="csrf-approvals">
      <ApprovalActions {...base} {...props} />
    </CsrfProvider>,
  );
}

const calls = () => fetchMock.mock.calls.map(([url, init]) => ({ url: url as string, body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown> }));

describe('ApprovalActions', () => {
  it('approve posts the version on screen with the workspace slug', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { approvalId: 'appr_1', quoteId: 'q1', status: 'APPROVED' }));
    renderActions();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Approve v2' })));
    expect(calls()[0]).toEqual({ url: '/api/app/approvals/appr_1/approve', body: { workspaceSlug: 'smile-avenue-dental', expectedVersion: 2 } });
    expect(toastSuccess).toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
  });

  it('a stale item answers 409: "changed since you opened it", no success', async () => {
    fetchMock.mockResolvedValueOnce(json(409, { code: 'APPROVAL_CHANGED', message: 'This item changed since you opened it. Reload to see the current version.', reference: 'req_9' }));
    renderActions();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Approve v2' })));
    expect(screen.getByRole('alert').textContent).toContain('This item changed since you opened it');
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('approve and send by email runs once on a double click and names the channel', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((r) => (resolve = r)));
    renderActions();
    const send = screen.getByRole('button', { name: 'Approve and send by email' });
    await act(async () => {
      fireEvent.click(send);
      fireEvent.click(send);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => resolve(json(200, { approvalId: 'appr_1', messageId: 'm1', attemptId: 'a1', jobId: 'j1', created: true })));
    expect(calls()[0]).toEqual({ url: '/api/app/approvals/appr_1/send', body: { workspaceSlug: 'smile-avenue-dental', expectedVersion: 2, channel: 'EMAIL' } });
  });

  it('WhatsApp without an approved template is gated with the configuration reason', () => {
    renderActions();
    fireEvent.click(screen.getByRole('radio', { name: /WhatsApp/ }));
    const send = screen.getByRole('button', { name: 'Approve and send on WhatsApp' });
    expect(send.getAttribute('aria-disabled')).toBe('true');
    expect(send.getAttribute('data-gate-category')).toBe('configuration');
    expect(screen.getByText('No approved WhatsApp template is synced.')).toBeTruthy();
  });

  it('the PDF must be ready before approve-and-send (eligibility gate)', () => {
    renderActions({ pdfReady: false });
    const send = screen.getByRole('button', { name: 'Approve and send by email' });
    expect(send.getAttribute('data-gate-category')).toBe('eligibility');
  });

  it('reject asks for a reason and posts it', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { approvalId: 'appr_1', status: 'REJECTED' }));
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Quantity is wrong' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reject item' })));
    expect(calls()[0]).toEqual({ url: '/api/app/approvals/appr_1/reject', body: { workspaceSlug: 'smile-avenue-dental', reason: 'Quantity is wrong' } });
  });

  it('a message draft is approved and sent in one step on its own channel', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { approvalId: 'appr_2', messageId: 'm2', attemptId: 'a2', jobId: 'j2', created: true }));
    renderActions({ approvalId: 'appr_2', kind: 'OUTBOUND_MESSAGE', label: 'Email draft', versionNo: null, channels: [{ channel: 'EMAIL', gate: null, templates: [], deferredLabels: [] }] });
    expect(screen.queryByRole('button', { name: /^Approve v/ })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Approve and send by email' })));
    expect(calls()[0]).toEqual({ url: '/api/app/approvals/appr_2/send', body: { workspaceSlug: 'smile-avenue-dental' } });
  });

  it('starts on the first usable channel and never pre-selects an unavailable one', () => {
    renderActions({
      channels: [
        { channel: 'EMAIL', gate: { category: 'eligibility', reason: 'No email opt-in or enabled B2B attestation.' }, templates: [], deferredLabels: [] },
        { channel: 'WHATSAPP', gate: null, templates: [{ id: 't1', name: 'quote_ready', language: 'en' }], deferredLabels: [] },
      ],
    });
    expect((screen.getByRole('radio', { name: /WhatsApp/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: /Email/ }) as HTMLInputElement).checked).toBe(false);
  });

  it('with no usable channel nothing is selected and the send explains why, once', () => {
    renderActions({
      channels: [
        { channel: 'EMAIL', gate: { category: 'eligibility', reason: 'No email opt-in or enabled B2B attestation.' }, templates: [], deferredLabels: [] },
        { channel: 'WHATSAPP', gate: { category: 'configuration', reason: 'No approved WhatsApp template is synced.' }, templates: [], deferredLabels: [] },
      ],
    });
    for (const radio of screen.getAllByRole('radio')) expect((radio as HTMLInputElement).checked).toBe(false);
    const send = screen.getByRole('button', { name: 'Approve and send' });
    expect(send.getAttribute('aria-disabled')).toBe('true');
    expect(send.getAttribute('data-gate-category')).toBe('eligibility');
    // The unavailable hint is readable text (text-2), not the low-contrast text-3 of the old pill.
    const hints = screen.getAllByText('(unavailable)');
    expect(hints).toHaveLength(2);
    for (const hint of hints) expect(hint.className).toContain('text-fg-2');
    // The channels' own reasons are the page's eligibility list; the component does not repeat them.
    expect(screen.queryByText('No approved WhatsApp template is synced.')).toBeNull();
    // Choosing a channel shows that channel's reason on the send control.
    fireEvent.click(screen.getByRole('radio', { name: /WhatsApp/ }));
    expect(screen.getByRole('button', { name: 'Approve and send on WhatsApp' }).getAttribute('data-gate-category')).toBe('configuration');
    expect(screen.getAllByText('No approved WhatsApp template is synced.')).toHaveLength(1);
  });

  it('sending an already approved quotation says "queued", not "approved and queued"', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { approvalId: 'appr_1', messageId: 'm1', attemptId: 'a1', jobId: 'j1', created: true }));
    renderActions({ status: 'APPROVED' });
    expect(screen.queryByRole('button', { name: /^Approve v/ })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send by email' })));
    expect(toastSuccess).toHaveBeenCalledWith('Q-0003 v2 queued by email.');
    expect(screen.getByRole('status').textContent).toBe('Q-0003 v2 queued by email.');
  });

  it('one primary action: the send when it can run; Approve leads when only the send is blocked', () => {
    renderActions();
    const send = screen.getByRole('button', { name: 'Approve and send by email' });
    const approve = screen.getByRole('button', { name: 'Approve v2' });
    expect(send.closest('[data-glow-frame]')).not.toBeNull();
    expect(approve.closest('[data-glow-frame]')).toBeNull();
    cleanup();

    renderActions({
      channels: [
        { channel: 'EMAIL', gate: { category: 'eligibility', reason: 'No email opt-in or enabled B2B attestation.' }, templates: [], deferredLabels: [] },
        { channel: 'WHATSAPP', gate: { category: 'configuration', reason: 'No approved WhatsApp template is synced.' }, templates: [], deferredLabels: [] },
      ],
    });
    const blockedSend = screen.getByRole('button', { name: 'Approve and send' });
    const leading = screen.getByRole('button', { name: 'Approve v2' });
    expect(leading.closest('[data-glow-frame]')).not.toBeNull();
    expect(leading.getAttribute('aria-disabled')).toBeNull();
    expect(blockedSend.closest('[data-glow-frame]')).toBeNull();
    // Approve comes first in reading and tab order; the blocked send follows with its reason.
    expect(leading.compareDocumentPosition(blockedSend) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelectorAll('[data-glow-frame]')).toHaveLength(1);
  });

  it('keyboard focus on a channel radio rings the whole pill', () => {
    renderActions();
    const pill = screen.getByRole('radio', { name: /Email/ }).closest('label') as HTMLElement;
    expect(pill.className).toContain('has-[:focus-visible]:outline-2');
    expect(pill.className).toContain('has-[:focus-visible]:outline-aura');
    // Only border and background animate, so the outline does not fade in from the text color.
    expect(pill.className).not.toMatch(/transition-colors|transition-all/);
  });

  it('channel pills are 44px touch targets below 1024px', () => {
    renderActions();
    for (const name of [/Email/, /WhatsApp/]) {
      const pill = screen.getByRole('radio', { name }).closest('label') as HTMLElement;
      expect(pill.className).toMatch(/(^| )min-h-11( |$)/);
      expect(pill.className).toMatch(/(^| )lg:min-h-10( |$)/);
    }
  });

  it('without approvals.decide every decision is gated by permission', async () => {
    renderActions({ permissions: { canDecide: false, canSend: false } });
    for (const name of ['Approve v2', 'Approve and send by email', 'Reject']) {
      expect(screen.getByRole('button', { name }).getAttribute('data-gate-category')).toBe('permission');
    }
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Approve v2' })));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
