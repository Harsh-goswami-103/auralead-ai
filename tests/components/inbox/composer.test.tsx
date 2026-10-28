/**
 * T22 inbox composer (06-design F5, §11.3 "Composer send", AT9): the eligibility line comes from the
 * server (`windowEndsAt`) and says the final check happens at send; Send posts once per request key
 * (a double click sends one request, a retry after a network failure reuses the key); a refusal
 * keeps the draft, shows the reason and switches the action to review or template, never "Sent";
 * "Save for review" posts the draft; without permission the send is gated, not hidden.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import { Composer, type ComposerProps } from '@/components/inbox/Composer';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

const base: ComposerProps = {
  conversationId: 'conv_1',
  channel: 'WHATSAPP',
  timeZone: 'Asia/Kolkata',
  serverNow: '2026-10-20T02:00:00.000Z',
  freeform: { eligible: true, deferrable: false, reasons: [], labels: [], windowEndsAt: '2026-10-21T00:00:00.000Z' },
  templates: [],
  templateGate: { category: 'configuration', reason: 'No approved WhatsApp template is synced.' },
  permissions: { canSend: true, canDraft: true },
};

function renderComposer(props: Partial<ComposerProps> = {}) {
  render(
    <CsrfProvider token="csrf-inbox">
      <Composer {...base} {...props} />
    </CsrfProvider>,
  );
}

function bodies() {
  return fetchMock.mock.calls.map(([url, init]) => ({ url: url as string, body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>, headers: (init as RequestInit).headers as Record<string, string> }));
}

async function type(text: string) {
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } });
}

describe('Composer', () => {
  it('shows the server window end and the final-check note', () => {
    renderComposer();
    expect(screen.getByText(/Free-form until 05:30 IST/)).toBeTruthy();
    expect(screen.getByText(/Final check happens at send/)).toBeTruthy();
  });

  it('sends once on a double click, with the CSRF header and a request key, then shows Queued', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((r) => (resolve = r)));
    renderComposer();
    await type('Yes, Saturday 11 am works.');
    const send = screen.getByRole('button', { name: 'Send' });
    await act(async () => {
      fireEvent.click(send);
      fireEvent.click(send);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => resolve(json(200, { messageId: 'm1', attemptId: 'a1', jobId: 'j1', approvalId: 'ap1', created: true, deferred: null })));
    const [call] = bodies();
    expect(call!.url).toBe('/api/app/messages');
    expect(call!.headers['x-csrf-token']).toBe('csrf-inbox');
    expect(call!.body).toMatchObject({ conversationId: 'conv_1', kind: 'TEXT', body: 'Yes, Saturday 11 am works.' });
    expect(String(call!.body.requestKey)).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(screen.getByRole('status').textContent).toContain('Queued');
    expect(screen.queryByText(/^Sent$/)).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it('a retry after a network failure reuses the same request key', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(json(200, { messageId: 'm1', attemptId: 'a1', jobId: 'j1', approvalId: 'ap1', created: true, deferred: null }));
    renderComposer();
    await type('Hello');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    expect(screen.getByRole('alert').textContent).toContain('could not be reached');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    const [a, b] = bodies();
    expect(a!.body.requestKey).toBe(b!.body.requestKey);
  });

  it('a refusal keeps the draft, shows the reason and switches to review; never Sent', async () => {
    fetchMock
      .mockResolvedValueOnce(json(422, { code: 'SEND_REFUSED', message: 'Not sent: The 24-hour reply window is closed.', reference: 'req_1', details: { reasons: ['WINDOW_CLOSED'], next: 'REVIEW' } }))
      .mockResolvedValueOnce(json(200, { messageId: 'm2', approvalId: 'ap2' }));
    renderComposer();
    await type('We open at 10.');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    expect(screen.getByRole('alert').textContent).toContain('24-hour reply window is closed');
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('We open at 10.');
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.queryByText('Queued')).toBeNull();
    expect(screen.queryByText(/^Sent$/)).toBeNull();
    // The template path explains why it cannot be used; review is the action.
    expect(screen.getByRole('button', { name: 'Send approved template' }).getAttribute('aria-disabled')).toBe('true');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save for review' })));
    const last = bodies().at(-1)!;
    expect(last.url).toBe('/api/app/messages/drafts');
    expect(last.body).toMatchObject({ conversationId: 'conv_1', kind: 'TEXT', body: 'We open at 10.' });
    expect(screen.getByRole('status').textContent).toContain('Saved for review');
  });

  it('a refusal for another reason does not blame the window (an opt-out says so, and no template is suggested)', async () => {
    fetchMock.mockResolvedValueOnce(json(422, { code: 'SEND_REFUSED', message: 'Not sent: The contact has opted out.', reference: 'req_2', details: { reasons: ['SUPPRESSED'], next: 'NONE' } }));
    renderComposer();
    await type('Hello again.');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    const line = document.querySelector('[data-composer-eligibility]')!.textContent ?? '';
    expect(line).not.toMatch(/Free-form window closed/);
    expect(line).toContain('The contact has opted out.');
    expect(screen.getByRole('alert').textContent).not.toContain('Send an approved template instead');
  });

  it('a closed window renders the review path from the start (server said WINDOW_CLOSED)', () => {
    renderComposer({ freeform: { eligible: false, deferrable: false, reasons: ['WINDOW_CLOSED'], labels: ['The 24-hour reply window is closed'], windowEndsAt: null } });
    expect(screen.getByText(/Free-form window closed/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save for review' })).toBeTruthy();
  });

  it('without the send permission the action is gated by permission, nothing is posted', async () => {
    renderComposer({ permissions: { canSend: false, canDraft: true } });
    await type('Hello');
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send.getAttribute('aria-disabled')).toBe('true');
    expect(send.getAttribute('data-gate-category')).toBe('permission');
    await act(async () => fireEvent.click(send));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('email conversations ask for a subject and post kind EMAIL', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { messageId: 'm3', attemptId: 'a3', jobId: 'j3', approvalId: 'ap3', created: true, deferred: null }));
    renderComposer({ channel: 'EMAIL', freeform: { eligible: true, deferrable: false, reasons: [], labels: [], windowEndsAt: null }, templateGate: null });
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Your visit' } });
    await type('See you on Friday.');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    expect(bodies()[0]!.body).toMatchObject({ kind: 'EMAIL', subject: 'Your visit', body: 'See you on Friday.' });
  });
});
