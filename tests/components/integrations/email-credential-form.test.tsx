/**
 * T33 email credential forms (plan §9 Credentials, ADR-100, ADR-101): the Resend form asks for the
 * sending domain, the from address, the API key and the `whsec_` webhook signing secret (both
 * password fields that start empty); the SMTP form takes only the SMTP ports and keeps the
 * password's exact characters. The browser copy of the server rules refuses a malformed from
 * address, a signing secret that is not `whsec_...` and a non-SMTP port before anything is sent.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialForm, type CredentialFormProps } from '@/components/integrations/CredentialForm';
import { CsrfProvider } from '@/components/patterns/csrf';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const SIGNING = `whsec_${Buffer.alloc(32, 5).toString('base64')}`;

const resend: CredentialFormProps = {
  workspaceSlug: 'live-dental-co',
  workspaceName: 'Live Dental Co',
  kind: 'EMAIL_RESEND',
  kindSlug: 'email-resend',
  label: 'Resend email',
  provider: 'Resend',
  mode: 'live',
  timeZone: 'Asia/Kolkata',
  config: [
    { key: 'fromDomain', label: 'Sending domain', value: null },
    { key: 'fromAddress', label: 'From address', value: null },
  ],
  credentials: [
    { field: 'apiKey', label: 'API key', saved: false, last4: null, updatedAt: null },
    { field: 'webhookSecret', label: 'Webhook signing secret', saved: false, last4: null, updatedAt: null },
  ],
  credentialProblem: null,
};

const smtp: CredentialFormProps = {
  ...resend,
  kind: 'EMAIL_SMTP',
  kindSlug: 'email-smtp',
  label: 'SMTP email',
  provider: 'Your mail server',
  config: [
    { key: 'host', label: 'SMTP host', value: null },
    { key: 'port', label: 'Port', value: null },
    { key: 'username', label: 'Username', value: null },
    { key: 'fromAddress', label: 'From address', value: null },
  ],
  credentials: [{ field: 'password', label: 'Password', saved: false, last4: null, updatedAt: null }],
};

const renderForm = (props: CredentialFormProps) => render(<CsrfProvider token="csrf-email">{<CredentialForm {...props} />}</CsrfProvider>);

describe('Resend credential form', () => {
  it('asks for the from address and the whsec_ signing secret, both secrets as empty password fields', () => {
    renderForm(resend);
    expect(screen.getByLabelText(/From address/)).toBeTruthy();
    for (const label of ['API key', 'Webhook signing secret']) {
      const input = screen.getByLabelText(label) as HTMLInputElement;
      expect(input.type).toBe('password');
      expect(input.value).toBe('');
    }
    expect(screen.getByText(/starts with whsec_/)).toBeTruthy();
  });

  it('refuses a malformed from address and a signing secret that is not whsec_, sending nothing', async () => {
    renderForm(resend);
    fireEvent.change(screen.getByLabelText(/Sending domain/), { target: { value: 'example.com' } });
    fireEvent.change(screen.getByLabelText(/From address/), { target: { value: 'not an address' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 're_formTestKey0000000000' } });
    fireEvent.change(screen.getByLabelText('Webhook signing secret'), { target: { value: 'plainsecretvalue123' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save credentials' })));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/From address/).getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('Webhook signing secret').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('The signing secret starts with whsec_ followed by the key Resend shows.')).toBeTruthy();
  });

  it('posts the settings and secrets and clears them', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { status: 'CONFIGURED_UNVERIFIED', simulated: false, saved: ['apiKey', 'webhookSecret'], replaced: [], configChanged: ['fromDomain', 'fromAddress'] }));
    const { container } = renderForm(resend);
    fireEvent.change(screen.getByLabelText(/Sending domain/), { target: { value: 'example.com' } });
    fireEvent.change(screen.getByLabelText(/From address/), { target: { value: 'quotes@example.com' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 're_formTestKey0000000000' } });
    fireEvent.change(screen.getByLabelText('Webhook signing secret'), { target: { value: SIGNING } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save credentials' })));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/app/integrations/email-resend/credentials');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      workspaceSlug: 'live-dental-co',
      config: { fromDomain: 'example.com', fromAddress: 'quotes@example.com' },
      credentials: { apiKey: 're_formTestKey0000000000', webhookSecret: SIGNING },
    });
    expect(container.innerHTML).not.toContain(SIGNING);
  });
});

describe('SMTP credential form', () => {
  it('accepts only the SMTP ports and keeps the password exactly as typed', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { status: 'CONFIGURED_UNVERIFIED', simulated: false, saved: ['password'], replaced: [], configChanged: ['host', 'port', 'username', 'fromAddress'] }));
    renderForm(smtp);
    fireEvent.change(screen.getByLabelText(/SMTP host/), { target: { value: 'smtp.example.com' } });
    fireEvent.change(screen.getByLabelText(/Port/), { target: { value: '6379' } });
    fireEvent.change(screen.getByLabelText(/Username/), { target: { value: 'quotes' } });
    fireEvent.change(screen.getByLabelText(/From address/), { target: { value: 'quotes@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: ' pass W0rd! ' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save credentials' })));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('The port must be 25, 465, 587 or 2525.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Port/), { target: { value: '587' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: ' pass W0rd! ' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save credentials' })));
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)).credentials).toEqual({ password: ' pass W0rd! ' });
  });
});
