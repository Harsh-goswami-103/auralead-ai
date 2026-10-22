/**
 * ADR-121 inbox controls:
 * - "Automatic sending" is labelled with everything it controls (AI replies and automated pipeline
 *   sends), is a switch with its state in words, confirms with the workspace name and posts to
 *   /api/app/settings/auto-send (with the operator's workspace slug); without automation.manage it
 *   is permission-gated, never hidden.
 * - "Customer's phone (Simulated)" (DEMO): the customer's side in a phone frame; a typed message and
 *   a quick reply go to the simulator route with the lead (and the operator's workspace slug); one
 *   submission per click.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import { AutoSendToggle } from '@/components/inbox/AutoSendToggle';
import { CustomerPhone } from '@/components/inbox/CustomerPhone';

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
const calls = () => fetchMock.mock.calls.map(([url, init]) => ({ url: url as string, body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown> }));

describe('AutoSendToggle', () => {
  it('says what it controls, confirms with the workspace and posts the new state with the slug', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { enabled: true, changed: true }));
    render(
      <CsrfProvider token="csrf-auto">
        <AutoSendToggle enabled={false} canManage workspaceName="Codecraft Web Studio" workspaceSlug="codecraft-web" />
      </CsrfProvider>,
    );
    const toggle = screen.getByRole('switch', { name: 'Automatic sending (AI replies and automated pipeline sends)' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.textContent).toContain('Automatic sending: Off');
    fireEvent.click(toggle);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Workspace: Codecraft Web Studio');
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on' })));
    expect(calls()).toEqual([{ url: '/api/app/settings/auto-send', body: { enabled: true, workspaceSlug: 'codecraft-web' } }]);
    expect(refresh).toHaveBeenCalled();
  });

  it('without automation.manage it is gated by permission with its reason', async () => {
    render(
      <CsrfProvider token="csrf-auto">
        <AutoSendToggle enabled canManage={false} workspaceName="Codecraft Web Studio" />
      </CsrfProvider>,
    );
    const gated = screen.getByRole('button', { name: 'Automatic sending: On' });
    expect(gated.getAttribute('aria-disabled')).toBe('true');
    expect(gated.getAttribute('data-gate-category')).toBe('permission');
    await act(async () => fireEvent.click(gated));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('CustomerPhone', () => {
  const messages = [
    { id: 'm1', from: 'customer' as const, text: 'Do you build websites?', time: '10:00 IST' },
    { id: 'm2', from: 'business' as const, text: 'Yes, five-page business websites.', time: '10:01 IST' },
  ];

  it("is titled Customer's phone (Simulated) and mirrors the thread from the customer's side", () => {
    render(
      <CsrfProvider token="csrf-phone">
        <CustomerPhone leadId="lead_1" leadName="Priya Sharma" businessName="Codecraft Web Studio" messages={messages} canSimulate />
      </CsrfProvider>,
    );
    const panel = document.querySelector('[data-customer-phone]') as HTMLElement;
    expect(panel.querySelector('h2')?.textContent).toBe("Customer's phone Simulated");
    const list = screen.getByRole('list', { name: "Messages on the customer's phone" });
    expect(list.textContent).toContain('Do you build websites?');
    expect(list.textContent).toContain('Yes, five-page business websites.');
  });

  it('sends a typed message once per click and a quick reply, with the workspace slug', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (resolve = r))).mockResolvedValueOnce(json(200, { messageId: 'wamid.x', events: [] }));
    render(
      <CsrfProvider token="csrf-phone">
        <CustomerPhone leadId="lead_1" leadName="Priya Sharma" businessName="Codecraft Web Studio" messages={messages} canSimulate workspaceSlug="codecraft-web" />
      </CsrfProvider>,
    );
    fireEvent.change(screen.getByLabelText('Customer text'), { target: { value: 'How long does a website take?' } });
    const send = screen.getByRole('button', { name: 'Simulate customer message' });
    await act(async () => {
      fireEvent.click(send);
      fireEvent.click(send);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => resolve(json(200, { messageId: 'wamid.y', events: [] })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Get quote' })));
    expect(calls()).toEqual([
      { url: '/api/webhooks/whatsapp/simulate', body: { leadId: 'lead_1', event: 'text', text: 'How long does a website take?', workspaceSlug: 'codecraft-web' } },
      { url: '/api/webhooks/whatsapp/simulate', body: { leadId: 'lead_1', event: 'quick_reply_quote', workspaceSlug: 'codecraft-web' } },
    ]);
    expect(screen.getByRole('status').textContent).toContain('Simulated.');
  });
});
