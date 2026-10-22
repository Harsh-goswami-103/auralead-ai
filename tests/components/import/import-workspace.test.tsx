/**
 * ADR-120 (slice F2): the import page's working area. Without leads.import the file button is
 * focusable with the reason and takes no file. A chosen file is checked in the browser (type, 5
 * MB), then sent as base64 with a fresh request key; the preview shows the suggested mapping, the
 * first rows and a data-source choice, and confirm sends the full mapping. The opt-in section is
 * shown only to an owner (consent.import) and sends the attestation verbatim only when ticked.
 * Progress follows the import's own counts; the result groups row-level reasons by code. The
 * export panel's file type choice sends `format` and labels the download.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { precheckImportFile } from '@/components/leads/import/FileDropZone';
import { ImportProgress, ImportResult } from '@/components/leads/import/ImportStatus';
import { ImportWorkspace } from '@/components/leads/import/ImportWorkspace';
import { mappingProblems } from '@/components/leads/import/MappingStep';
import { LeadExportPanel } from '@/components/leads/LeadExportPanel';
import { CsrfProvider } from '@/components/patterns/csrf';
import { consentAttestationText, type LeadImportDto, type LeadImportView } from '@/lib/schemas/lead-import';
import type { LeadExportDto } from '@/lib/schemas/leads';

const replace = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

afterEach(() => {
  cleanup();
  replace.mockReset();
  refresh.mockReset();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubFetch(handler: (url: string, body: Record<string, unknown> | null) => Response) {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url, body });
      return handler(url, body);
    }),
  );
  return calls;
}

const BUSINESS = 'Smile Avenue Dental Clinic';
const CONSENT_OFF = { allowed: false, noticeDefault: '', attestationText: consentAttestationText(BUSINESS), businessName: BUSINESS };
const CONSENT_ON = { ...CONSENT_OFF, allowed: true, noticeDefault: `${BUSINESS} will send you offers on WhatsApp.` };

function dto(over: Partial<LeadImportDto> = {}): LeadImportDto {
  return {
    id: 'imp_1',
    status: 'PREVIEW',
    effectiveStatus: 'PREVIEW',
    fileName: 'shops.csv',
    sheetName: 'shops',
    rowCount: 3,
    header: ['Shop', 'Mobile', 'Town', 'Opt in', 'Opt-in date'],
    mapping: null,
    dataSource: null,
    consentAttested: false,
    counts: { accepted: 0, duplicates: 0, review: 0, rejected: 0, consentRecorded: 0, processed: 0 },
    notes: [],
    createdAt: '2026-10-16T06:00:00.000Z',
    expiresAt: '2026-10-17T06:00:00.000Z',
    finishedAt: null,
    ...over,
  };
}

const PREVIEW: LeadImportView = {
  import: dto(),
  preview: {
    header: ['Shop', 'Mobile', 'Town', 'Opt in', 'Opt-in date'],
    rows: [
      { row: 2, cells: ['Sharma Sweets', '98260 10001', 'Indore', 'yes', '14/09/2026'] },
      { row: 3, cells: ['Gupta Tailors', '98260 10002', 'Indore', '', ''] },
    ],
    suggestedMapping: { name: 0, phone: 1, city: 2, consent: 3, consentDate: 4 },
  },
};

function renderWorkspace(props: Partial<Parameters<typeof ImportWorkspace>[0]> = {}) {
  return render(
    <CsrfProvider token="csrf-import">
      <ImportWorkspace workspaceSlug="smile-avenue-dental" basePath="/dashboard/employee/smile-avenue-dental/leads/import" leadsHref="/dashboard/employee/smile-avenue-dental/leads" gate={null} consent={CONSENT_OFF} initial={null} {...props} />
    </CsrfProvider>,
  );
}

describe('uploading', () => {
  it('without leads.import the button is focusable with the reason, and no file is taken', () => {
    const calls = stubFetch(() => json({}));
    renderWorkspace({ gate: { category: 'permission', reason: 'Your assignment does not include leads.import.' } });
    const button = screen.getByRole('button', { name: 'Choose a file' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('Your assignment does not include leads.import.')).toBeTruthy();
    expect((screen.getByLabelText('Spreadsheet file to import') as HTMLInputElement).disabled).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('checks the type and size in the browser first', () => {
    expect(precheckImportFile({ name: 'old.xls', size: 10 })).toMatch(/xlsx or .csv/);
    expect(precheckImportFile({ name: 'a.CSV', size: 0 })).toBe('The file is empty.');
    expect(precheckImportFile({ name: 'big.xlsx', size: 6 * 1024 * 1024 })).toMatch(/5 MB/);
    expect(precheckImportFile({ name: 'ok.xlsx', size: 1024 })).toBeNull();
  });

  it('sends the file as base64 with a fresh request key and shows the mapping and preview', async () => {
    const calls = stubFetch(() => json({ ...PREVIEW, created: true }));
    renderWorkspace();
    const input = screen.getByLabelText('Spreadsheet file to import') as HTMLInputElement;
    const file = new File(['Shop,Mobile\nSharma Sweets,98260 10001\n'], 'shops.csv', { type: 'text/csv' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await screen.findByText('Which column holds what');
    expect(calls[0]!.url).toBe('/api/app/leads/imports');
    expect(calls[0]!.body).toMatchObject({ workspaceSlug: 'smile-avenue-dental', fileName: 'shops.csv', contentType: 'text/csv' });
    expect(Buffer.from(String(calls[0]!.body!.dataBase64), 'base64').toString('utf8')).toBe('Shop,Mobile\nSharma Sweets,98260 10001\n');
    expect(calls[0]!.body!.requestKey).toMatch(/^[0-9a-f]{32}$/);
    expect(replace).toHaveBeenCalledWith('/dashboard/employee/smile-avenue-dental/leads/import?import=imp_1', { scroll: false });
    expect((screen.getByLabelText(/Business name/) as HTMLSelectElement).value).toBe('0');
    expect((screen.getByLabelText('Phone') as HTMLSelectElement).value).toBe('1');
    expect(screen.getByRole('table').textContent).toContain('Gupta Tailors');
    // Without consent.import the opt-in section is not offered.
    expect(screen.queryByText(/WhatsApp opt-ins in this file/)).toBeNull();
  });

  it('a refused file shows the server message and its reference', async () => {
    stubFetch(() => json({ code: 'NOT_A_WORKBOOK', message: 'This file is not a readable Excel workbook.', reference: 'req_9' }, 422));
    renderWorkspace();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Spreadsheet file to import'), { target: { files: [new File(['x'], 'a.xlsx')] } });
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This file is not a readable Excel workbook.');
    expect(alert.textContent).toContain('req_9');
  });
});

describe('mapping and confirming', () => {
  it('says what is missing, then sends the full mapping and the data source', async () => {
    const calls = stubFetch((url) => (url.endsWith('/confirm') ? json({ import: dto({ status: 'QUEUED', effectiveStatus: 'QUEUED' }), consent: { requested: false, honoured: false, reason: 'NOT_REQUESTED' } }) : json(PREVIEW)));
    renderWorkspace({ initial: PREVIEW });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Import 3 rows' }));
    });
    expect(screen.getByRole('alert').textContent).toContain('Say where this list came from.');
    expect(calls).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('Where this list came from'), { target: { value: 'PUBLIC_DIRECTORY' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Import 3 rows' }));
    });
    await screen.findByRole('progressbar');
    const confirm = calls.find((c) => c.url === '/api/app/leads/imports/imp_1/confirm')!;
    expect(confirm.body).toEqual({
      workspaceSlug: 'smile-avenue-dental',
      mapping: { name: 0, phone: 1, email: null, website: null, address: null, city: 2, category: null, rating: null, reviewCount: null, pincode: null, consent: null, consentDate: null },
      dataSource: 'PUBLIC_DIRECTORY',
    });
  });

  it('a column fills one field: choosing it again moves it', () => {
    stubFetch(() => json({}));
    renderWorkspace({ initial: PREVIEW });
    fireEvent.change(screen.getByLabelText('City'), { target: { value: '1' } });
    expect((screen.getByLabelText('City') as HTMLSelectElement).value).toBe('1');
    expect((screen.getByLabelText('Phone') as HTMLSelectElement).value).toBe('');
    expect(mappingProblems({ name: 0, city: 1 }, 'OWN_CUSTOMERS')).toEqual(['Choose a phone or an email column.']);
  });

  it('an owner sees the opt-in section; the attestation is sent verbatim only when ticked', async () => {
    const calls = stubFetch(() => json({ import: dto({ status: 'QUEUED', effectiveStatus: 'QUEUED' }), consent: { requested: true, honoured: true, reason: null } }));
    renderWorkspace({ initial: PREVIEW, consent: CONSENT_ON });
    const section = screen.getByRole('group', { name: /WhatsApp opt-ins in this file/ });
    expect((within(section).getByLabelText('WhatsApp opt-in') as HTMLSelectElement).value).toBe('3');
    expect((within(section).getByLabelText('Opt-in date') as HTMLSelectElement).value).toBe('4');
    expect((within(section).getByLabelText('The notice these people saw') as HTMLTextAreaElement).value).toBe(CONSENT_ON.noticeDefault);
    fireEvent.change(screen.getByLabelText('Where this list came from'), { target: { value: 'OWN_CUSTOMERS' } });

    fireEvent.click(within(section).getByLabelText(consentAttestationText(BUSINESS)));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Import 3 rows' }));
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toMatchObject({
      dataSource: 'OWN_CUSTOMERS',
      mapping: { consent: 3, consentDate: 4 },
      consent: { noticeText: CONSENT_ON.noticeDefault, attestation: consentAttestationText(BUSINESS) },
    });
  });

  it('without the tick no consent block is sent', async () => {
    const calls = stubFetch(() => json({ import: dto({ status: 'QUEUED', effectiveStatus: 'QUEUED' }), consent: { requested: false, honoured: false, reason: 'NOT_REQUESTED' } }));
    renderWorkspace({ initial: PREVIEW, consent: CONSENT_ON });
    fireEvent.change(screen.getByLabelText('Where this list came from'), { target: { value: 'OWN_CUSTOMERS' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Import 3 rows' }));
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).not.toHaveProperty('consent');
  });
});

describe('progress and result', () => {
  it('progress is the import’s own processed count', () => {
    render(<ImportProgress dto={dto({ status: 'RUNNING', effectiveStatus: 'RUNNING', rowCount: 450, counts: { accepted: 190, duplicates: 5, review: 0, rejected: 5, consentRecorded: 0, processed: 200 } })} exhausted={false} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('200');
    expect(bar.getAttribute('aria-valuemax')).toBe('450');
    expect(screen.getByText('200 of 450 rows processed')).toBeTruthy();
  });

  it('the result shows the counts and groups the reasons by code with row numbers', () => {
    const { container } = render(
      <ImportResult
        dto={dto({
          status: 'SUCCEEDED',
          effectiveStatus: 'SUCCEEDED',
          consentAttested: true,
          counts: { accepted: 440, duplicates: 6, review: 1, rejected: 3, consentRecorded: 12, processed: 450 },
          notes: [
            { row: 6, code: 'MISSING_NAME', field: 'name' },
            { row: 11, code: 'NO_VALID_CONTACT' },
            { row: 9, code: 'MISSING_NAME', field: 'name' },
            { row: 40, code: 'SUPPRESSED_CONTACT' },
          ],
        })}
        consent={null}
        mappedConsent
      />,
    );
    expect(container.textContent).toContain('New leads');
    expect(container.textContent).toContain('440');
    expect(container.textContent).toContain('WhatsApp opt-ins recorded');
    const missing = container.querySelector('[data-note-code="MISSING_NAME"]')!;
    expect(missing.textContent).toContain('No business name: 2 rows');
    expect(missing.textContent).toContain('Rows 6, 9');
    const suppressed = container.querySelector('[data-note-code="SUPPRESSED_CONTACT"]')!;
    expect(suppressed.closest('section')!.getAttribute('aria-label')).toBe('Imported without a WhatsApp opt-in');
  });

  it('says why a consent column was ignored', () => {
    render(<ImportResult dto={dto({ status: 'SUCCEEDED', effectiveStatus: 'SUCCEEDED' })} consent={{ requested: true, honoured: false, reason: 'DATA_SOURCE_NOT_OWN' }} mappedConsent />);
    expect(screen.getByText(/lists the business collected itself/)).toBeTruthy();
  });
});

const exportRow = (id: string, format: LeadExportDto['format']): LeadExportDto => ({
  id,
  format,
  status: 'READY',
  effectiveStatus: 'READY',
  filters: { sort: 'newest' },
  rowCount: 4,
  truncated: false,
  bytes: 4096,
  createdAt: '2026-10-16T06:00:00.000Z',
  completedAt: '2026-10-16T06:01:00.000Z',
  expiresAt: '2026-10-17T06:01:00.000Z',
  downloadCount: 0,
});

describe('LeadExportPanel file type', () => {
  it('sends the chosen format and labels each download by its format', async () => {
    const calls = stubFetch(() => json({ export: exportRow('exp_new', 'xlsx'), created: true }));
    render(
      <CsrfProvider token="csrf-export">
        <LeadExportPanel exports={[exportRow('exp_c', 'csv'), exportRow('exp_x', 'xlsx')]} filters={{ sort: 'newest' }} gate={null} workspaceSlug="smile-avenue-dental" timeZone="Asia/Kolkata" filtered={false} />
      </CsrfProvider>,
    );
    expect(screen.getByRole('button', { name: 'Export all leads (CSV)' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Excel (.xlsx)'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export all leads (Excel)' }));
    });
    expect(calls[0]!.body).toMatchObject({ format: 'xlsx', filters: { sort: 'newest' } });
    expect(screen.getAllByRole('link', { name: 'Download CSV' })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: 'Download Excel' })).toHaveLength(1);
  });
});
