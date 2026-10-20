/**
 * T27 branding forms: the logo picker refuses SVG and files over 1 MB in the browser before any
 * request (the server checks again), and sends an accepted image as base64 with the CSRF header;
 * the colour preview shows the exact text colour quotations paint and its contrast on white
 * (F14), and saves only a valid #rrggbb; GSTIN and terms post together; a member sees every
 * control gated by permission.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import { brandPalette } from '@/components/quote/brand-palette';
import { contrastRatio } from '@/lib/branding/contrast';
import type { BrandingDto } from '@/server/services/pricing/branding';
import { BrandingWorkspace } from '@/app/dashboard/user/pricing/branding/branding-forms';

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

function branding(canEdit: boolean, logo = false): BrandingDto {
  return {
    workspace: { name: 'Alpha Dental', timezone: 'Asia/Kolkata' },
    brandColor: '#FFD400',
    termsText: 'Valid 15 days.',
    gstin: null,
    logo: logo ? { sha256: 'a'.repeat(64), url: '/api/app/branding/logo?v=aaaaaaaaaaaaaaaa' } : null,
    updatedAt: '2026-10-20T06:00:00.000Z',
    canEdit,
  };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function renderForms(canEdit = true, logo = false) {
  return render(
    <CsrfProvider token="csrf-token-123">
      <BrandingWorkspace branding={branding(canEdit, logo)} />
    </CsrfProvider>,
  );
}

function fileInput(container: HTMLElement) {
  return container.querySelector('input[type="file"]') as HTMLInputElement;
}

async function pick(container: HTMLElement, file: File) {
  await act(async () => {
    fireEvent.change(fileInput(container), { target: { files: [file] } });
  });
}

describe('logo', () => {
  it('refuses an SVG and a file over 1 MB without a request', async () => {
    const { container } = renderForms();
    expect(fileInput(container).getAttribute('accept')).toBe('image/png,image/jpeg,image/webp');
    await pick(container, new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }));
    expect(screen.getByRole('alert').textContent).toContain('Use a PNG, JPEG or WebP image');
    await pick(container, new File([new Uint8Array(1_048_577)], 'big.png', { type: 'image/png' }));
    expect(screen.getByRole('alert').textContent).toContain('larger than 1 MB');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends an accepted image as base64 with the CSRF header and re-reads the page', async () => {
    fetchMock.mockResolvedValue(ok({ branding: branding(true, true) }));
    const { container } = renderForms();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await pick(container, new File([bytes], 'logo.png', { type: 'image/png' }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/app/branding/logo');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-token-123');
    const body = JSON.parse(String(init.body)) as { contentType: string; fileName: string; dataBase64: string };
    expect(body).toMatchObject({ contentType: 'image/png', fileName: 'logo.png' });
    expect(Buffer.from(body.dataBase64, 'base64').equals(Buffer.from(bytes))).toBe(true);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('shows the stored logo with a remove action', () => {
    renderForms(true, true);
    expect(screen.getByRole('img', { name: 'Logo of Alpha Dental' }).getAttribute('src')).toBe('/api/app/branding/logo?v=aaaaaaaaaaaaaaaa');
    expect(screen.getByRole('button', { name: 'Remove logo' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace logo' })).toBeTruthy();
  });
});

describe('brand colour', () => {
  it('previews the exact text colour and contrast quotations use', async () => {
    renderForms();
    const p = brandPalette('#FFD400');
    expect(screen.getByText(p.text)).toBeTruthy();
    expect(screen.getByText(`${(Math.floor(contrastRatio(p.text, '#FFFFFF') * 100) / 100).toFixed(2)}:1 on white`)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Hex value'), { target: { value: '#0F766E' } });
    expect(screen.getAllByText('#0F766E').length).toBeGreaterThan(0);
  });

  it('saves only a valid #rrggbb', async () => {
    fetchMock.mockResolvedValue(ok({ branding: branding(true) }));
    renderForms();
    fireEvent.change(screen.getByLabelText('Hex value'), { target: { value: 'teal' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save brand colour' }));
    });
    expect(screen.getByText(/Enter # and six hex digits/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Hex value'), { target: { value: '#0f766e' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save brand colour' }));
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/app/branding');
    expect(JSON.parse(String(init.body))).toEqual({ brandColor: '#0f766e' });
  });
});

describe('sender details', () => {
  it('checks the GSTIN format and posts GSTIN and terms together', async () => {
    fetchMock.mockResolvedValue(ok({ branding: branding(true) }));
    renderForms();
    fireEvent.change(screen.getByLabelText('GSTIN'), { target: { value: '07AAACR5055K1' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save GSTIN and terms' }));
    });
    expect(screen.getByText(/A GSTIN has 15 characters/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('GSTIN'), { target: { value: '07aaacr5055k1z5' } });
    fireEvent.change(screen.getByLabelText('Terms'), { target: { value: 'Line one\nLine two' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save GSTIN and terms' }));
    });
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ gstin: '07AAACR5055K1Z5', termsText: 'Line one\nLine two' });
  });
});

describe('member view', () => {
  it('shows the details read-only with every control gated by permission', () => {
    renderForms(false, true);
    expect(screen.getAllByText('Only the workspace owner can change branding.').length).toBeGreaterThan(0);
    for (const name of ['Replace logo', 'Save brand colour', 'Save GSTIN and terms']) {
      expect(screen.getByRole('button', { name }).getAttribute('aria-disabled')).toBe('true');
    }
    expect(screen.queryByRole('button', { name: 'Remove logo' })).toBeNull();
  });
});
