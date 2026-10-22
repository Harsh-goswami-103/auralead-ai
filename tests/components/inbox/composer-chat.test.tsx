/**
 * ADR-121 / ADR-123 / ADR-124 composer behaviour in both panels:
 * - per-lead template values: lead and workspace sources show this lead's value (or "missing"),
 *   other positions are typed; the preview bubble fills both; the send posts only the typed values;
 * - a refusal with the server's own reason (a missing template value) is shown as is, nothing "Sent";
 * - the operator inbox names its workspace in every request (`workspaceSlug`);
 * - a handed-over lead is read-only for the operator: the composer is replaced by its reason.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import { Composer, type ComposerProps } from '@/components/inbox/Composer';
import type { ComposerTemplate } from '@/server/services/messaging/inbox';

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

const template: ComposerTemplate = {
  id: 'tpl_1',
  name: 'website_intro',
  language: 'en',
  category: 'MARKETING',
  variables: ['1', '2', '3'],
  fields: [
    { position: '1', source: 'lead.firstName', sourceLabel: 'Customer first name', value: 'Priya', editable: false, missing: null },
    { position: '2', source: 'lead.city', sourceLabel: 'Customer city', value: null, editable: false, missing: 'NO_VALUE' },
    { position: '3', source: 'manual', sourceLabel: 'Typed by the person sending', value: null, editable: true, missing: null },
  ],
  preview: { headerFormat: 'TEXT', headerText: 'Codecraft Web Studio', documentName: null, body: 'Hi Priya, websites in {{2}} start with {{3}}.', footer: 'Reply STOP to opt out', buttons: [{ type: 'QUICK_REPLY', text: 'Stop promotions' }] },
  notSendable: null,
};

const base: ComposerProps = {
  conversationId: 'conv_1',
  channel: 'WHATSAPP',
  timeZone: 'Asia/Kolkata',
  serverNow: '2026-10-20T02:00:00.000Z',
  freeform: { eligible: true, deferrable: false, reasons: [], labels: [], windowEndsAt: '2026-10-21T00:00:00.000Z' },
  templates: [template],
  templateGate: null,
  permissions: { canSend: true, canDraft: true },
};

function renderComposer(props: Partial<ComposerProps> = {}) {
  render(
    <CsrfProvider token="csrf-chat">
      <Composer {...base} {...props} />
    </CsrfProvider>,
  );
}

function lastBody(): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('Composer per-lead template values (ADR-123)', () => {
  it('shows lead values read-only, the missing one in words, a field for the typed one and a filled preview', () => {
    renderComposer();
    expect(document.querySelector('[data-template-field="1"]')?.textContent).toContain('Priya');
    expect(document.querySelector('[data-template-field="2"]')?.textContent).toContain('Missing: this lead has none');
    fireEvent.change(screen.getByLabelText('{{3}} Typed by the person sending'), { target: { value: 'a free consultation call' } });
    const preview = document.querySelector('[data-template-preview]') as HTMLElement;
    expect(preview.textContent).toContain('Hi Priya, websites in {{2}} start with a free consultation call.');
    expect(preview.textContent).toContain('Stop promotions');
  });

  it('posts only the typed positions and shows the server reason when a value is missing; nothing reads Sent', async () => {
    fetchMock.mockResolvedValueOnce(
      json(422, {
        code: 'TEMPLATE_VARIABLES_MISSING',
        message: 'Not sent: template value {{2}} (Customer city) is missing because this lead has no value for it.',
        reference: 'req_9',
        details: { missing: [{ position: '2', source: 'lead.city', reason: 'NO_VALUE' }] },
      }),
    );
    renderComposer();
    fireEvent.change(screen.getByLabelText('{{3}} Typed by the person sending'), { target: { value: 'one call' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send approved template' })));
    expect(lastBody()).toMatchObject({ conversationId: 'conv_1', kind: 'TEMPLATE', templateId: 'tpl_1', variables: { '3': 'one call' } });
    expect(Object.keys(lastBody().variables as object)).toEqual(['3']);
    expect(screen.getByRole('alert').textContent).toContain('{{2}} (Customer city) is missing');
    expect(screen.queryByText(/^Sent$/)).toBeNull();
  });

  it('a template this app cannot send is gated by eligibility with the reason', () => {
    renderComposer({ templates: [{ ...template, notSendable: 'Has an image, video or location header, which this app does not send' }] });
    const send = screen.getByRole('button', { name: 'Send approved template' });
    expect(send.getAttribute('aria-disabled')).toBe('true');
    expect(send.getAttribute('data-gate-category')).toBe('eligibility');
  });
});

describe('Composer in the operator inbox', () => {
  it('names the workspace in the send and the review requests', async () => {
    fetchMock.mockResolvedValue(json(200, { messageId: 'm1', attemptId: 'a1', jobId: 'j1', approvalId: 'ap1', created: true, deferred: null }));
    renderComposer({ workspaceSlug: 'codecraft-web', templates: [] , templateGate: { category: 'configuration', reason: 'No approved WhatsApp template yet.' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Happy to help.' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    expect(lastBody()).toMatchObject({ workspaceSlug: 'codecraft-web', kind: 'TEXT', body: 'Happy to help.' });
  });

  it('is replaced by its reason once the lead is handed over (ADR-124)', () => {
    renderComposer({ readOnly: { reason: 'Handed over to Codecraft Web Studio on 21 Oct 2026. Only the client messages this lead now.' } });
    const box = document.querySelector('[data-composer-readonly]') as HTMLElement;
    expect(box.textContent).toContain('Only the client messages this lead now.');
    expect(screen.queryByLabelText('Message')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });
});
