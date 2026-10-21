/**
 * T36 Extension hub: the token is shown once. Creating posts the name, the optional allowed
 * extension id and the expiry with the CSRF header; the answer's token appears in a read-only field
 * with Copy; "Done" removes it from the page and re-reads the list (only the prefix remains). A
 * malformed extension id is refused in the browser before anything is sent; a server refusal (the
 * 10-token limit) is shown with its reference.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import { CreateTokenForm } from '@/app/dashboard/employee/[ws]/extension/create-token-form';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));

const fetchMock = vi.fn();
const writeText = vi.fn(async () => undefined);
beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  writeText.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TOKEN = `alx_0123456789abcdef_${'Q'.repeat(43)}`;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const renderForm = () => render(<CsrfProvider token="csrf-ext">{<CreateTokenForm workspaceSlug="smile-avenue-dental" limitReached={false} limit={10} />}</CsrfProvider>);

describe('CreateTokenForm', () => {
  it('creates a token, shows it once with Copy, and forgets it on Done', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { token: TOKEN, prefix: 'alx_0123456789abcdef', name: 'Front desk' }));
    renderForm();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Front desk' } });
    fireEvent.change(screen.getByLabelText('Allowed extension id (optional)'), { target: { value: 'abcdefghijklmnopabcdefghijklmnop' } });
    fireEvent.change(screen.getByLabelText('Expires'), { target: { value: '90' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create token' })));

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/app/extension/tokens');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-ext');
    expect(JSON.parse(String(init.body))).toEqual({ workspaceSlug: 'smile-avenue-dental', name: 'Front desk', allowedExtensionId: 'abcdefghijklmnopabcdefghijklmnop', expiresInDays: 90 });

    const field = screen.getByLabelText('New ingestion token') as HTMLInputElement;
    expect(field.value).toBe(TOKEN);
    expect(field.readOnly).toBe(true);
    expect(screen.getByText(/shown only this once/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy ingestion token' })));
    expect(writeText).toHaveBeenCalledWith(TOKEN);

    fireEvent.click(screen.getByRole('button', { name: 'Done, I copied it' }));
    expect(refresh).toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it('refuses a malformed extension id without a request', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('Allowed extension id (optional)'), { target: { value: 'chrome-extension://nope' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create token' })));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/32 letters/);
  });

  it('shows a server refusal with its reference and no token', async () => {
    fetchMock.mockResolvedValueOnce(json(422, { code: 'EXTENSION_TOKEN_LIMIT', message: 'This workspace already has 10 active tokens.', reference: 'req_limit' }));
    renderForm();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'eleventh' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create token' })));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('already has 10 active tokens');
    expect(alert.textContent).toContain('req_limit');
    expect(screen.queryByLabelText('New ingestion token')).toBeNull();
  });
});
