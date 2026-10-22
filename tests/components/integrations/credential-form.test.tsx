/**
 * T32 credential form (plan §9 Credentials, ADR-25): credentials are password fields that always
 * start empty and are cleared after every answer, so a secret is never in the DOM after a save and
 * a saved value is never shown (only "Saved •••• last four" and when); every field has a label, a
 * hint and, when the browser's copy of the server rules refuses it, an error tied by
 * aria-describedby with aria-invalid (nothing is sent then); a valid save posts only changed
 * settings and entered secrets with the CSRF header and says the integration is configured but
 * not verified (LIVE) or a demo placeholder (DEMO); DEMO asks for `demo_` placeholders; an
 * unreadable credential is announced; Revoke confirms first, then posts the typed confirmation.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialForm, type CredentialFormProps } from '@/components/integrations/CredentialForm';
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
const SECRET = 'EAAGformsecretPLAINTEXT0000000000000wxyz';

const base: CredentialFormProps = {
  workspaceSlug: 'live-dental-co',
  workspaceName: 'Live Dental Co',
  kind: 'WHATSAPP_CLOUD',
  kindSlug: 'whatsapp',
  label: 'WhatsApp Cloud API',
  provider: 'Meta',
  mode: 'live',
  timeZone: 'Asia/Kolkata',
  config: [
    { key: 'phoneNumberId', label: 'Phone number ID', value: null },
    { key: 'wabaId', label: 'WhatsApp Business Account ID', value: null },
    { key: 'businessPortfolioId', label: 'Business portfolio ID', value: null },
  ],
  credentials: [{ field: 'accessToken', label: 'System user access token', saved: false, last4: null, updatedAt: null }],
  credentialProblem: null,
};

const renderForm = (props: Partial<CredentialFormProps> = {}) => render(<CsrfProvider token="csrf-cred">{<CredentialForm {...base} {...props} />}</CsrfProvider>);

describe('CredentialForm', () => {
  it('labels every field; the credential is an empty password field with its hint', () => {
    renderForm();
    const token = screen.getByLabelText('System user access token') as HTMLInputElement;
    expect(token.type).toBe('password');
    expect(token.value).toBe('');
    expect(token.getAttribute('autocomplete')).toBe('off');
    expect(token.getAttribute('aria-describedby')).toMatch(/hint/);
    expect(screen.getByLabelText(/Phone number ID/)).toBeTruthy();
    expect(screen.getByText('Not saved')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Revoke/ })).toBeNull();
  });

  it('refuses malformed values in the browser (aria-invalid + message), sending nothing', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/Phone number ID/), { target: { value: '12ab' } });
    fireEvent.change(screen.getByLabelText('System user access token'), { target: { value: 'has spaces but long enough here' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save credentials' })));
    expect(fetchMock).not.toHaveBeenCalled();
    const phone = screen.getByLabelText(/Phone number ID/);
    expect(phone.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('The phone number ID is a number of 5 to 32 digits.')).toBeTruthy();
    expect(screen.getByLabelText('System user access token').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/cannot contain spaces/)).toBeTruthy();
  });

  it('posts changed settings and the entered secret with CSRF, clears the secret, and says it is not verified yet', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { status: 'CONFIGURED_UNVERIFIED', simulated: false, saved: ['accessToken'], replaced: [], configChanged: ['phoneNumberId', 'wabaId'] }));
    const { container } = renderForm();
    fireEvent.change(screen.getByLabelText(/Phone number ID/), { target: { value: '109876543210987' } });
    fireEvent.change(screen.getByLabelText(/WhatsApp Business Account ID/), { target: { value: '209876543210987' } });
    fireEvent.change(screen.getByLabelText('System user access token'), { target: { value: SECRET } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save credentials' })));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/app/integrations/whatsapp/credentials');
    expect((init as RequestInit).headers).toMatchObject({ 'x-csrf-token': 'csrf-cred' });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      workspaceSlug: 'live-dental-co',
      config: { phoneNumberId: '109876543210987', wabaId: '209876543210987' },
      credentials: { accessToken: SECRET },
    });
    expect((screen.getByLabelText('System user access token') as HTMLInputElement).value).toBe('');
    expect(container.innerHTML).not.toContain(SECRET);
    expect(container.innerHTML).not.toContain('PLAINTEXT');
    expect(screen.getByRole('status').textContent).toMatch(/configured, not verified\. Run Test connection/);
    expect(refresh).toHaveBeenCalled();
  });

  it('a refused save shows the message and reference and still clears the typed secret', async () => {
    fetchMock.mockResolvedValueOnce(json(409, { code: 'ROUTING_KEY_TAKEN', message: 'This phone number ID is already connected to another workspace.', reference: 'req_x1' }));
    const { container } = renderForm({ config: base.config.map((c) => ({ ...c, value: c.key === 'businessPortfolioId' ? null : '109876543210987' })) });
    fireEvent.change(screen.getByLabelText('System user access token'), { target: { value: SECRET } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save credentials' })));
    expect(screen.getByRole('alert').textContent).toContain('already connected to another workspace');
    expect(screen.getByRole('alert').textContent).toContain('req_x1');
    expect(container.innerHTML).not.toContain(SECRET);
  });

  it('a saved credential shows only its last four and time; leaving it empty keeps it', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { status: 'CONFIGURED_UNVERIFIED', simulated: false, saved: [], replaced: [], configChanged: ['businessPortfolioId'] }));
    renderForm({
      config: [
        { key: 'phoneNumberId', label: 'Phone number ID', value: '109876543210987' },
        { key: 'wabaId', label: 'WhatsApp Business Account ID', value: '209876543210987' },
        { key: 'businessPortfolioId', label: 'Business portfolio ID', value: null },
      ],
      credentials: [{ field: 'accessToken', label: 'System user access token', saved: true, last4: 'wxyz', updatedAt: new Date('2026-10-20T06:00:00.000Z') }],
    });
    expect(screen.getByText('Saved •••• wxyz')).toBeTruthy();
    expect((screen.getByLabelText('System user access token') as HTMLInputElement).placeholder).toBe('Leave empty to keep the saved value');
    fireEvent.change(screen.getByLabelText(/Business portfolio ID/), { target: { value: '30987654321' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })));
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ workspaceSlug: 'live-dental-co', config: { businessPortfolioId: '30987654321' }, credentials: {} });
  });

  it('DEMO asks for demo_ placeholders and refuses a real-looking token in the browser', async () => {
    renderForm({ mode: 'demo', config: [] });
    expect(screen.getByText(/DEMO stores placeholders only/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('System user access token'), { target: { value: SECRET } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save credentials' })));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText('System user access token').getAttribute('aria-invalid')).toBe('true');
  });

  it('announces an unreadable credential', () => {
    renderForm({ credentialProblem: 'Credential unreadable, re-enter', credentials: [{ field: 'accessToken', label: 'System user access token', saved: true, last4: 'wxyz', updatedAt: null }] });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Credential unreadable, re-enter');
  });

  it('Revoke asks first, then posts the typed confirmation', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { revoked: ['accessToken'] }));
    renderForm({ credentials: [{ field: 'accessToken', label: 'System user access token', saved: true, last4: 'wxyz', updatedAt: null }] });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Revoke credentials' })));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/revoke the token in the Meta console/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke credentials' })));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/app/integrations/whatsapp/credentials/revoke');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ workspaceSlug: 'live-dental-co', confirm: 'REVOKE' });
    expect(refresh).toHaveBeenCalled();
  });
});
