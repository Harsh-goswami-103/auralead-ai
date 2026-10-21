/**
 * T34 live controls of the Google Sheets page:
 *  - mapping editor: loads row 1 from the server, maps fields and the consent column (P1), previews
 *    the next rows as a dry run (per-row outcome and consent, "nothing was written"), and confirms
 *    with the header fingerprint and the version it started from; drift is shown as a column diff;
 *  - Apps Script panel: issues the signing secret and shows it exactly once with a copy button,
 *    rotation is confirmed in a dialog, the script is shown with copy and setup steps, a loopback
 *    APP_ORIGIN is called out; DEMO gates issuing on mode;
 *  - sync panel: Sync now posts the slug; a blocked run shows the column diff; runs list counts;
 *    gated controls stay focusable and send nothing.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppsScriptPanel } from '@/app/dashboard/employee/[ws]/sheets/AppsScriptPanel';
import { SheetsMappingEditor } from '@/app/dashboard/employee/[ws]/sheets/SheetsMappingEditor';
import { SheetsSyncPanel, type SyncRunRow } from '@/app/dashboard/employee/[ws]/sheets/SheetsSyncPanel';
import { CsrfProvider } from '@/components/patterns/csrf';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }), usePathname: () => '/dashboard/employee/live-co/sheets' }));
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
const wrap = (node: ReactNode) => render(<CsrfProvider token="csrf-sheets">{node}</CsrfProvider>);
const bodyOf = (i: number) => JSON.parse(String((fetchMock.mock.calls[i]![1] as RequestInit).body)) as Record<string, unknown>;
const HEADER = ['Timestamp', 'Full name', 'Phone number', 'Email address', 'WhatsApp updates'];
const FP = 'f'.repeat(64);

describe('SheetsMappingEditor', () => {
  it('loads columns, maps fields and consent, previews without writing, and confirms with the fingerprint', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { tab: 'Form Responses 1', columns: HEADER, duplicates: [], hasEventIdColumn: true, headerFingerprint: FP, activeVersion: 0, drift: null }));
    wrap(<SheetsMappingEditor workspaceSlug="live-co" initial={null} activeVersion={0} gate={null} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Load columns from the Sheet' })));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/app/sheets/header');
    expect(bodyOf(0)).toEqual({ workspaceSlug: 'live-co' });

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Full name' } });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: 'Phone number' } });
    fireEvent.change(screen.getByLabelText('Submission time'), { target: { value: 'Timestamp' } });
    fireEvent.change(screen.getByLabelText('Consent column'), { target: { value: 'WhatsApp updates' } });
    fireEvent.change(screen.getByLabelText('Answers that mean yes'), { target: { value: 'Yes, Haan' } });
    fireEvent.change(screen.getByLabelText('Notice text shown on the form'), { target: { value: 'Send me offers on WhatsApp.' } });

    fetchMock.mockResolvedValueOnce(
      json(200, {
        fromRow: 2,
        drift: null,
        rows: [
          { rowNumber: 2, outcome: 'CREATE', reasonCode: null, displayName: 'Asha', contacts: ['phone'], consent: 'WOULD_CAPTURE', weakId: false },
          { rowNumber: 3, outcome: 'REJECT', reasonCode: 'NO_VALID_CONTACT', displayName: null, contacts: [], consent: 'REJECTED', weakId: false },
        ],
        counts: { CREATE: 1, MERGE: 0, REVIEW: 0, ALREADY_RECEIVED: 0, REJECT: 1 },
        emptyRows: [],
        pendingRows: [4],
      }),
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Preview rows' })));
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/app/sheets/preview');
    const mapping = { fieldMap: { name: 'Full name', phone: 'Phone number' }, submittedAtColumn: 'Timestamp', consent: { column: 'WhatsApp updates', truthyValues: ['Yes', 'Haan'], channel: 'WHATSAPP', purpose: 'MARKETING', noticeText: 'Send me offers on WhatsApp.' } };
    expect(bodyOf(1)).toEqual({ workspaceSlug: 'live-co', mapping });
    const table = screen.getByRole('table', { name: /Preview of the next rows/ });
    expect(within(table).getByText('New lead')).toBeTruthy();
    expect(within(table).getByText('Opt-in would be recorded')).toBeTruthy();
    expect(within(table).getByText('No valid phone number or email')).toBeTruthy();
    expect(screen.getByText(/Nothing was written/)).toBeTruthy();
    expect(screen.getByText(/Row 4 is waiting for its auralead_event_id/)).toBeTruthy();

    fetchMock.mockResolvedValueOnce(json(200, { version: 1, previousVersion: null, headerFingerprint: FP, columns: HEADER }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Confirm mapping' })));
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/app/sheets/mapping');
    expect(bodyOf(2)).toEqual({ workspaceSlug: 'live-co', expectedVersion: 0, headerFingerprint: FP, mapping });
    expect(screen.getByRole('status').textContent).toContain('Mapping version 1 confirmed');
    expect(refresh).toHaveBeenCalled();
  });

  it('shows the column diff when the Sheet drifted, and a server refusal with its reference', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { tab: 'Form Responses 1', columns: ['Timestamp', 'Full name', 'Mobile'], duplicates: [], hasEventIdColumn: false, headerFingerprint: FP, activeVersion: 2, drift: { added: ['Mobile'], removed: ['Phone number'] } }));
    wrap(<SheetsMappingEditor workspaceSlug="live-co" initial={{ fieldMap: { name: 'Full name', phone: 'Phone number' }, submittedAtColumn: 'Timestamp', consent: null }} activeVersion={2} gate={null} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Load columns from the Sheet' })));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Added: Mobile');
    expect(alert.textContent).toContain('Removed: Phone number');
    fetchMock.mockResolvedValueOnce(json(422, { code: 'SHEET_NOT_SHARED', message: 'Google refused access: share the Sheet with reader@x.iam.gserviceaccount.com.', reference: 'req_9' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Preview rows' })));
    expect(screen.getAllByRole('alert').map((a) => a.textContent).join(' ')).toContain('reader@x.iam.gserviceaccount.com');
  });

  it('DEMO: gated on mode, nothing sent', async () => {
    wrap(<SheetsMappingEditor workspaceSlug="demo-co" initial={null} activeVersion={1} gate={{ category: 'mode', reason: 'DEMO never contacts Google.' }} />);
    const button = screen.getByRole('button', { name: 'Load columns from the Sheet' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('DEMO never contacts Google.')).toBeTruthy();
    await act(async () => fireEvent.click(button));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('AppsScriptPanel', () => {
  const base = { workspaceSlug: 'live-co', workspaceName: 'Live Co', endpoint: 'https://app.example.com/api/webhooks/google-sheets', originReachable: true, timeZone: 'Asia/Kolkata', gate: null };

  it('issues the secret and shows it once with a copy button', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { keyId: 'as_newKeyId0001', secret: 'S3cr3t-value-shown-once-only-0000000000000', rotated: false, issuedAt: '2026-10-20T06:00:00.000Z' }));
    wrap(<AppsScriptPanel {...base} keyId={null} secretIssuedAt={null} script={null} scriptMissingReason="Issue the signing secret to get the script." />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Issue signing secret' })));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/app/sheets/apps-script/secret');
    expect(bodyOf(0)).toEqual({ workspaceSlug: 'live-co' });
    const shown = screen.getByTestId('secret-once');
    expect(shown.textContent).toContain('S3cr3t-value-shown-once-only-0000000000000');
    expect(shown.textContent).toMatch(/only time/);
    expect(screen.getByRole('button', { name: 'Copy signing secret' })).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it('shows the script with copy and setup steps, rotation behind a confirmation, and a warning for a loopback origin', async () => {
    wrap(<AppsScriptPanel {...base} originReachable={false} endpoint="http://localhost:3000/api/webhooks/google-sheets" keyId="as_existing0001" secretIssuedAt="2026-10-19T06:00:00.000Z" script={'var AURALEAD = {};\nfunction onOpen() {}'} scriptMissingReason={null} />);
    expect(screen.getByText(/var AURALEAD/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy Apps Script' })).toBeTruthy();
    expect(screen.getByText(/Set signing secret/)).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(/cannot reach/);
    expect(screen.getByText('as_existing0001')).toBeTruthy();
    fetchMock.mockResolvedValueOnce(json(200, { keyId: 'as_rotated00001', secret: 'R0tated-secret-value-000000000000000000000', rotated: true, issuedAt: '2026-10-20T06:00:00.000Z' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Rotate signing secret' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Rotate secret' })));
    expect(bodyOf(0)).toEqual({ workspaceSlug: 'live-co', confirm: 'ROTATE' });
    expect(screen.getByTestId('secret-once').textContent).toContain('R0tated-secret-value-000000000000000000000');
  });

  it('DEMO: issuing is gated on mode and nothing is sent', async () => {
    wrap(<AppsScriptPanel {...base} keyId={null} secretIssuedAt={null} script={null} scriptMissingReason="DEMO rows come from the simulator." gate={{ category: 'mode', reason: 'DEMO never issues an Apps Script secret.' }} />);
    const button = screen.getByRole('button', { name: 'Issue signing secret' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await act(async () => fireEvent.click(button));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('DEMO rows come from the simulator.')).toBeTruthy();
  });
});

describe('SheetsSyncPanel', () => {
  const run = (over: Partial<SyncRunRow> = {}): SyncRunRow => ({
    id: 'run_1',
    status: 'SUCCEEDED' as const,
    createdAt: '2026-10-20T05:00:00.000Z',
    finishedAt: '2026-10-20T05:00:05.000Z',
    fromRow: 2,
    cursorRow: 9,
    rowsRead: 8,
    created: 5,
    duplicate: 1,
    review: 0,
    rejected: 1,
    skipped: 1,
    weakIdRows: 0,
    pendingRows: [],
    errorCode: null,
    errorMessage: null,
    mappingVersion: 1,
    ...over,
  });

  it('Sync now posts the slug and the runs show their counts', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { runId: 'run_2', status: 'QUEUED', jobId: 'job_1', alreadyQueued: false }));
    wrap(<SheetsSyncPanel workspaceSlug="live-co" runs={[run()]} cursorRow={9} open={false} drift={null} gate={null} timeZone="Asia/Kolkata" />);
    const table = screen.getByRole('table', { name: /Recent syncs/ });
    expect(within(table).getByText('Succeeded')).toBeTruthy();
    expect(within(table).getAllByRole('row')[1]!.textContent).toContain('8');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sync now' })));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/app/sheets/sync');
    expect(bodyOf(0)).toEqual({ workspaceSlug: 'live-co' });
    expect(refresh).toHaveBeenCalled();
  });

  it('a blocked run shows the column diff; a gated Sync now sends nothing', async () => {
    wrap(
      <SheetsSyncPanel
        workspaceSlug="live-co"
        runs={[run({ status: 'BLOCKED', errorCode: 'HEADER_DRIFT', errorMessage: 'The Sheet’s columns changed.', rowsRead: 0 })]}
        cursorRow={1}
        open={false}
        drift={{ added: ['Mobile'], removed: ['Phone number'] }}
        gate={{ category: 'configuration', reason: 'Re-confirm the mapping: the Sheet’s columns changed.' }}
        timeZone="Asia/Kolkata"
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Added: Mobile');
    expect(alert.textContent).toContain('Removed: Phone number');
    expect(screen.getByText('Blocked')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Sync now' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await act(async () => fireEvent.click(button));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
