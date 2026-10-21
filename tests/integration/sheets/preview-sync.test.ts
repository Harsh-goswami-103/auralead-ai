/**
 * T34 (plan §11 T34, P14, R8, ADR-103..105), against the scripted Google stand-in (documented-shape
 * fixtures, zero outbound connections):
 *  - connection test = header fetch through the service account: CONNECTED only on Google's answer;
 *    403 "not shared" is ERROR SHEET_NOT_SHARED with the service account address to share with;
 *    API disabled, unknown spreadsheet, wrong tab and a rejected key have their own codes;
 *    throttling never passes and never fails the credentials; DEMO contacts nobody;
 *  - mapping: confirmed only against the live header (stale header 409, invalid mapping 422);
 *  - preview is a dry run: every table's row count is unchanged afterwards;
 *  - drift (a renamed column) blocks Sync now with the column diff until the mapping is re-confirmed;
 *  - the Apps Script push and the sync never double-create (one source record per auralead_event_id);
 *    rows still waiting for their id are skipped and the cursor stops before them;
 *  - a Sheet without the event id column syncs with flagged weak ids; the cursor moves forward;
 *  - the signing secret: LIVE only, issued once, rotation needs ROTATE, stored as an envelope;
 *  - permissions: a MEMBER (no sheets.manage) gets 403.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getJobContext } from '@/server/auth/context';
import { credentialAad, decryptSecretString } from '@/server/security/secrets';
import { testIntegrationConnection } from '@/server/services/integrations/connection-test';
import { liveAdapters } from '@/server/services/integrations/live-adapters';
import { openSheets } from '@/server/services/sheets/access';
import { analyzeHeader } from '@/server/services/sheets/header';
import { confirmSheetMapping } from '@/server/services/sheets/mapping';
import { previewSheetRows } from '@/server/services/sheets/preview';
import { issueAppsScriptSecret } from '@/server/services/sheets/secret';
import { requestSheetsSync } from '@/server/services/sheets/sync';
import { createSheetsHarness, formRow, HEADER, MAPPING, postPush, pushBody, SA_EMAIL, setUpWorkspace, sheetsFixture, storeSheets, type SheetsHarness } from './support';

let h: SheetsHarness;

beforeAll(async () => {
  h = await createSheetsHarness('t34-preview-sync');
}, 120_000);
afterAll(async () => h?.destroy());
beforeEach(() => h.google.reset());

const SERIAL = 46315 + 10.5 / 24; // 2026-10-20 10:30 in the sheet's zone (Asia/Kolkata) = 05:00Z
const owner = () => h.ctx(h.wsA.ownerId, h.wsA.id);
const testerDeps = () => ({ keyRing: h.ring, graphVersion: null, sheets: { http: h.google.http } });
const runTest = async () => testIntegrationConnection(await owner(), { kind: 'GOOGLE_SHEETS' }, { testers: liveAdapters(testerDeps()).testers });

async function tableCounts(): Promise<Record<string, number>> {
  const tables = await h.db.$queryRawUnsafe<Array<{ name: string }>>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%'`);
  const out: Record<string, number> = {};
  for (const t of tables) out[t.name] = Number((await h.db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT COUNT(*) AS n FROM "${t.name}"`))[0]!.n);
  return out;
}

function sheetRow(name: string, phone: string, opts: { whatsapp?: string; eventId?: string | null; email?: string } = {}): unknown[] {
  const row: unknown[] = [SERIAL, name, Number(phone), opts.email ?? '', 'Consultation', opts.whatsapp ?? 'Yes'];
  if (opts.eventId !== undefined) row.push(opts.eventId ?? '');
  return row;
}

describe('connection test (header fetch)', () => {
  it('CONNECTED only on Google answering with row 1; the token is a read-only service account JWT', async () => {
    await storeSheets(h, h.wsA.id, { status: 'CONFIGURED_UNVERIFIED' });
    const result = await runTest();
    expect(result).toMatchObject({ outcome: 'TESTED', status: 'CONNECTED', errorCode: null });
    expect(h.google.tokenClaims).toEqual([expect.objectContaining({ iss: SA_EMAIL, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', aud: 'https://oauth2.googleapis.com/token' })]);
    expect(h.google.requests.map((r) => `${r.method} ${r.url.host}${decodeURIComponent(r.url.pathname)}`)).toEqual([
      'POST oauth2.googleapis.com/token',
      `GET sheets.googleapis.com/v4/spreadsheets/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789`,
      `GET sheets.googleapis.com/v4/spreadsheets/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/values/'Form Responses 1'!1:1`,
    ]);
    expect(h.google.unexpected).toEqual([]);
    expect(await h.db.integration.findFirstOrThrow({ where: { workspaceId: h.wsA.id, kind: 'GOOGLE_SHEETS' } })).toMatchObject({ status: 'CONNECTED', verifiedAt: h.clock.now() });
  });

  it('403 not shared: ERROR SHEET_NOT_SHARED naming the service account to share with', async () => {
    await storeSheets(h, h.wsA.id, { status: 'CONFIGURED_UNVERIFIED' });
    h.google.fail('meta', sheetsFixture('error.403-permission-denied.json'));
    const result = await runTest();
    expect(result).toMatchObject({ status: 'ERROR', errorCode: 'SHEET_NOT_SHARED' });
    expect(result.message).toMatch(/not shared with the service account/);
    expect(result.message).toMatch(/Share/);
    expect(result.message).toMatch(/Sheet URL alone grants no access/);
    // The stored error is redacted (addresses masked); a person's own request gets the address to share with.
    h.google.fail('meta', sheetsFixture('error.403-permission-denied.json'));
    const refused = await previewSheetRows(await owner(), {}, h.deps).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: 'SHEET_NOT_SHARED', status: 422 });
    expect((refused as { userMessage: string }).userMessage).toContain(SA_EMAIL);
  });

  it('maps API disabled, unknown spreadsheet, wrong tab, rejected key and throttling', async () => {
    const cases: Array<{ arm: () => void; status: string; code: string; previous?: 'CONNECTED' }> = [
      { arm: () => h.google.fail('meta', sheetsFixture('error.403-service-disabled.json')), status: 'ERROR', code: 'SHEETS_API_DISABLED' },
      { arm: () => h.google.fail('meta', sheetsFixture('error.404-not-found.json')), status: 'ERROR', code: 'CONFIG_INVALID' },
      { arm: () => h.google.fail('values', sheetsFixture('error.400-bad-range.json')), status: 'ERROR', code: 'CONFIG_INVALID' },
      { arm: () => h.google.fail('token', sheetsFixture('error.token-invalid-grant.json')), status: 'ERROR', code: 'PROVIDER_AUTH' },
      { arm: () => h.google.fail('meta', sheetsFixture('error.429-rate-limited.json')), status: 'CONFIGURED_UNVERIFIED', code: 'PROVIDER_RATE_LIMITED' },
      { arm: () => h.google.fail('meta', sheetsFixture('error.429-rate-limited.json')), status: 'DEGRADED', code: 'PROVIDER_RATE_LIMITED', previous: 'CONNECTED' },
      { arm: () => h.google.fail('meta', { throw: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }), status: 'CONFIGURED_UNVERIFIED', code: 'PROVIDER_UNREACHABLE' },
    ];
    for (const c of cases) {
      h.google.reset();
      await storeSheets(h, h.wsA.id, { status: c.previous ?? 'CONFIGURED_UNVERIFIED' });
      c.arm();
      const result = await runTest();
      expect(result, c.code).toMatchObject({ status: c.status, errorCode: c.code });
    }
  });

  it('a configured tab that does not exist is CONFIG_INVALID without reading values; DEMO never contacts Google', async () => {
    await storeSheets(h, h.wsA.id, { status: 'CONFIGURED_UNVERIFIED', sheetName: 'Responses' });
    await h.db.integration.updateMany({ where: { workspaceId: h.wsA.id, kind: 'GOOGLE_SHEETS' }, data: { config: { sheetId: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', sheetName: 'Responses' } } });
    const result = await runTest();
    expect(result).toMatchObject({ status: 'ERROR', errorCode: 'CONFIG_INVALID' });
    expect(result.message).toContain('Form Responses 1');
    await h.db.integration.updateMany({ where: { workspaceId: h.wsA.id, kind: 'GOOGLE_SHEETS' }, data: { config: { sheetId: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789' } } });

    h.google.reset();
    const demoCtx = { ...(await owner()), mode: 'demo' as const };
    const opened = await openSheets(demoCtx, h.deps);
    expect(opened).toMatchObject({ ok: false, failure: { code: 'SHEETS_LIVE_ONLY' } });
    expect(h.google.requests).toHaveLength(0);
  });
});

describe('mapping, preview, sync', () => {
  let A: Awaited<ReturnType<typeof setUpWorkspace>>;

  it('confirms a mapping only against the live header', async () => {
    await storeSheets(h, h.wsA.id);
    const ctx = await owner();
    const fp = analyzeHeader(HEADER).fingerprint;
    await expect(confirmSheetMapping(ctx, { expectedVersion: 0, headerFingerprint: analyzeHeader(['Other']).fingerprint, mapping: MAPPING }, h.deps)).rejects.toMatchObject({ code: 'HEADER_CHANGED', status: 409 });
    await expect(confirmSheetMapping(ctx, { expectedVersion: 0, headerFingerprint: fp, mapping: { ...MAPPING, fieldMap: { ...MAPPING.fieldMap, city: 'City' } } }, h.deps)).rejects.toMatchObject({ code: 'MAPPING_INVALID', status: 400 });
    await expect(confirmSheetMapping(ctx, { expectedVersion: 0, headerFingerprint: fp, mapping: { ...MAPPING, fieldMap: { name: 'Full name' } } }, h.deps)).rejects.toMatchObject({ code: 'MAPPING_INVALID' });
    await expect(confirmSheetMapping(ctx, { expectedVersion: 0, headerFingerprint: fp, mapping: { ...MAPPING, submittedAtColumn: null } }, h.deps)).rejects.toMatchObject({ code: 'MAPPING_INVALID' });
    expect(await h.db.sheetMapping.count({ where: { workspaceId: h.wsA.id } })).toBe(0);
    A = await setUpWorkspace(h, h.wsA);
    const stored = await h.db.sheetMapping.findFirstOrThrow({ where: { workspaceId: h.wsA.id, active: true } });
    expect(stored).toMatchObject({ version: 1, headerFingerprint: fp, headerColumns: HEADER, submittedAtColumn: 'Timestamp' });
    expect(stored.consentMapping).toMatchObject({ column: 'WhatsApp updates', noticeTextHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    await expect(confirmSheetMapping(ctx, { expectedVersion: 0, headerFingerprint: fp, mapping: MAPPING }, h.deps)).rejects.toMatchObject({ code: 'MAPPING_VERSION_CONFLICT', status: 409 });
  });

  it('preview is a dry run: it says what would happen per row and writes nothing', async () => {
    // A lead that already exists (merge), a row the script already pushed (already received).
    const pushed = formRow({ rowKey: 'evt-row-pushed', name: 'Pushed Before', phone: '9811100002' });
    expect((await postPush(h, A, pushBody([pushed]))).status).toBe(200);
    await h.drain();
    const existing = await h.db.lead.findFirstOrThrow({ where: { workspaceId: h.wsA.id, displayName: 'Pushed Before' } });

    h.google.header = [...HEADER, 'auralead_event_id'];
    h.google.rows = [
      sheetRow('New Person', '9811100001', { eventId: 'evt-row-new' }),
      sheetRow('Pushed Before', '9811100002', { eventId: 'evt-row-pushed' }),
      sheetRow('Same Phone Other Row', '9811100002', { eventId: 'evt-row-merge', whatsapp: 'No' }),
      ['', 'No Contact', '', '', '', 'Yes', 'evt-row-nocontact'],
      [],
      sheetRow('Waiting For Id', '9811100005', { eventId: null }),
    ];
    const ctx = await owner();
    const before = await tableCounts();
    const preview = await previewSheetRows(ctx, {}, h.deps);
    expect(await tableCounts()).toEqual(before);
    expect(preview).toMatchObject({ mappingVersion: 1, proposed: false, fromRow: 2, drift: null, emptyRows: [6], pendingRows: [7] });
    expect(preview.rows.map((r) => [r.rowNumber, r.outcome, r.reasonCode, r.consent])).toEqual([
      [2, 'CREATE', null, 'WOULD_CAPTURE'],
      [3, 'ALREADY_RECEIVED', 'ALREADY_RECEIVED', 'NOT_CAPTURED'],
      [4, 'MERGE', 'CONTACT_MATCH', 'FALSY_VALUE'],
      [5, 'REJECT', 'NO_VALID_CONTACT', 'REJECTED'],
    ]);
    expect(preview.counts).toEqual({ CREATE: 1, MERGE: 1, REVIEW: 0, ALREADY_RECEIVED: 1, REJECT: 1 });
    expect(await h.db.lead.count({ where: { workspaceId: h.wsA.id, displayName: 'New Person' } })).toBe(0);
    expect(existing.id).toBeTruthy();
  });

  it('script + sync never double-create; a row waiting for its id is skipped and the cursor stops before it', async () => {
    const leadsBefore = await h.db.lead.count({ where: { workspaceId: h.wsA.id } });
    h.google.header = [...HEADER, 'auralead_event_id'];
    h.google.rows = [
      sheetRow('New Person', '9811100001', { eventId: 'evt-row-new' }),
      sheetRow('Pushed Before', '9811100002', { eventId: 'evt-row-pushed' }),
      sheetRow('Same Phone Other Row', '9811100002', { eventId: 'evt-row-merge', whatsapp: 'No' }),
      ['', 'No Contact', '', '', '', 'Yes', 'evt-row-nocontact'],
      [],
      sheetRow('Waiting For Id', '9811100005', { eventId: null }),
      sheetRow('After Waiting', '9811100006', { eventId: 'evt-row-after' }),
    ];
    const req = await requestSheetsSync(await owner());
    expect(req).toMatchObject({ status: 'QUEUED', alreadyQueued: false });
    expect(await requestSheetsSync(await owner())).toMatchObject({ runId: req.runId, alreadyQueued: true });
    await h.drain();
    const run = await h.db.sheetSyncRun.findUniqueOrThrow({ where: { id: req.runId } });
    expect(run).toMatchObject({ status: 'SUCCEEDED', fromRow: 2, rowsRead: 7, created: 2, duplicate: 2, rejected: 1, skipped: 2, weakIdRows: 0, cursorRow: 6 });
    expect(run.detail).toEqual({ pendingRows: [7] });
    expect(await h.db.lead.count({ where: { workspaceId: h.wsA.id } })).toBe(leadsBefore + 2);
    expect(await h.db.leadSourceRecord.count({ where: { workspaceId: h.wsA.id, externalId: 'evt-row-pushed' } })).toBe(1);
    const newLead = await h.db.lead.findFirstOrThrow({ where: { workspaceId: h.wsA.id, displayName: 'New Person' } });
    expect(await h.db.consentRecord.count({ where: { leadId: newLead.id, source: 'SHEETS_FORM', collectedAt: new Date('2026-10-20T05:00:00.000Z') } })).toBe(1);

    // The script now pushes a row the sync already read, with the same auralead_event_id: no second lead.
    const late = formRow({ rowKey: 'evt-row-after', name: 'After Waiting', phone: '9811100006' });
    expect((await postPush(h, A, pushBody([late]))).status).toBe(200);
    await h.drain();
    expect(await h.db.lead.count({ where: { workspaceId: h.wsA.id, displayName: 'After Waiting' } })).toBe(1);

    // The script assigns the waiting row's id and pushes it; the next sync re-reads from the cursor and creates nothing twice.
    h.google.rows[5] = sheetRow('Waiting For Id', '9811100005', { eventId: 'evt-row-waited' });
    expect((await postPush(h, A, pushBody([formRow({ rowKey: 'evt-row-waited', name: 'Waiting For Id', phone: '9811100005' })]))).status).toBe(200);
    await h.drain();
    const second = await requestSheetsSync(await owner());
    await h.drain();
    const run2 = await h.db.sheetSyncRun.findUniqueOrThrow({ where: { id: second.runId } });
    expect(run2).toMatchObject({ status: 'SUCCEEDED', fromRow: 7, rowsRead: 2, created: 0, duplicate: 2, cursorRow: 8 });
    expect(await h.db.lead.count({ where: { workspaceId: h.wsA.id, displayName: 'Waiting For Id' } })).toBe(1);
  });

  it('drift blocks the sync with the column diff until the mapping is re-confirmed', async () => {
    h.google.header = ['Timestamp', 'Full name', 'Mobile', 'Email address', 'Interested in', 'WhatsApp updates', 'auralead_event_id'];
    h.google.rows = Array.from({ length: 7 }, () => []);
    h.google.rows.push(['', 'Drift Person', 9811100099, '', '', 'Yes', 'evt-row-drift']);
    const leadsBefore = await h.db.lead.count({ where: { workspaceId: h.wsA.id } });
    const req = await requestSheetsSync(await owner());
    await h.drain();
    const run = await h.db.sheetSyncRun.findUniqueOrThrow({ where: { id: req.runId } });
    expect(run).toMatchObject({ status: 'BLOCKED', errorCode: 'HEADER_DRIFT', rowsRead: 0 });
    expect(run.detail).toEqual({ added: ['Mobile'], removed: ['Phone number'] });
    expect(await h.db.lead.count({ where: { workspaceId: h.wsA.id } })).toBe(leadsBefore);
    expect(h.google.requests.some((r) => decodeURIComponent(r.url.pathname).endsWith("'!9:208"))).toBe(false);
    const preview = await previewSheetRows(await owner(), { mapping: { ...MAPPING, fieldMap: { ...MAPPING.fieldMap, phone: 'Mobile' } } }, h.deps);
    expect(preview.drift).toEqual({ added: ['Mobile'], removed: ['Phone number'] });

    // Re-confirm with the new column; the next sync runs.
    await confirmSheetMapping(await owner(), { expectedVersion: 1, headerFingerprint: analyzeHeader(h.google.header).fingerprint, mapping: { ...MAPPING, fieldMap: { ...MAPPING.fieldMap, phone: 'Mobile' } } }, h.deps);
    const again = await requestSheetsSync(await owner());
    await h.drain();
    expect(await h.db.sheetSyncRun.findUniqueOrThrow({ where: { id: again.runId } })).toMatchObject({ status: 'SUCCEEDED', mappingVersion: 2, created: 1 });
    // The old script (mapping v1) is now refused until the new one is pasted.
    expect((await postPush(h, A, pushBody([formRow()], { mappingVersion: 1 }))).body.code).toBe('MAPPING_SUPERSEDED');
  });

  it('a provider failure settles the run FAILED with its code', async () => {
    h.google.header = ['Timestamp', 'Full name', 'Mobile', 'Email address', 'Interested in', 'WhatsApp updates'];
    h.google.fail('meta', sheetsFixture('error.403-permission-denied.json'));
    const req = await requestSheetsSync(await owner());
    await h.drain();
    const run = await h.db.sheetSyncRun.findUniqueOrThrow({ where: { id: req.runId } });
    expect(run).toMatchObject({ status: 'FAILED', errorCode: 'SHEET_NOT_SHARED' });
    expect(run.errorRedacted).toMatch(/Share/);
  });
});

describe('a Sheet without the event id column (no script yet)', () => {
  it('syncs with flagged weak ids and moves the cursor forward', async () => {
    await setUpWorkspace(h, h.wsB);
    const ownerB = await h.ctx(h.wsB.ownerId, h.wsB.id);
    h.google.rows = [sheetRow('Weak One', '9822200001'), sheetRow('Weak Two', '9822200002')];
    const first = await requestSheetsSync(ownerB);
    await h.drain();
    expect(await h.db.sheetSyncRun.findUniqueOrThrow({ where: { id: first.runId } })).toMatchObject({ status: 'SUCCEEDED', created: 2, weakIdRows: 2, cursorRow: 3 });
    const records = await h.db.leadSourceRecord.findMany({ where: { workspaceId: h.wsB.id } });
    expect(records.every((r) => r.externalId.startsWith('weak:') && (r.attribution as { weakId?: string }).weakId === 'content-hash')).toBe(true);
    h.google.rows.push(sheetRow('Weak Three', '9822200003'));
    const second = await requestSheetsSync(ownerB);
    await h.drain();
    expect(await h.db.sheetSyncRun.findUniqueOrThrow({ where: { id: second.runId } })).toMatchObject({ fromRow: 4, rowsRead: 1, created: 1, cursorRow: 4 });
  });
});

describe('signing secret and permissions', () => {
  it('is LIVE only, shown once, rotated only with ROTATE, and stored as an encrypted envelope', async () => {
    const ctx = await owner();
    await expect(issueAppsScriptSecret({ ...ctx, mode: 'demo' }, {}, { keyRing: h.ring })).rejects.toMatchObject({ code: 'SHEETS_LIVE_ONLY' });
    await expect(issueAppsScriptSecret(ctx, {}, { keyRing: h.ring })).rejects.toMatchObject({ code: 'APPS_SCRIPT_SECRET_EXISTS', status: 409 });
    const rotated = await issueAppsScriptSecret(ctx, { confirm: 'ROTATE' }, { keyRing: h.ring });
    expect(rotated.rotated).toBe(true);
    expect(rotated.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await h.db.integration.findFirstOrThrow({ where: { workspaceId: h.wsA.id, kind: 'GOOGLE_SHEETS' } });
    expect(row.routingKey).toBe(rotated.keyId);
    expect((row.config as { appsScriptKeyId: string }).appsScriptKeyId).toBe(rotated.keyId);
    const envelope = (row.secrets as Record<string, string>).appsScriptSecret!;
    expect(envelope).not.toContain(rotated.secret);
    expect(decryptSecretString(h.ring, envelope, credentialAad({ workspaceId: h.wsA.id, integrationId: row.id, field: 'appsScriptSecret' }))).toBe(rotated.secret);
    expect(() => decryptSecretString(h.ring, envelope, credentialAad({ workspaceId: h.wsB.id, integrationId: row.id, field: 'appsScriptSecret' }))).toThrow();
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'sheets.apps_script.secret', workspaceId: h.wsA.id }, orderBy: { createdAt: 'desc' } });
    expect(JSON.stringify(audit.summary)).not.toContain(rotated.secret);
  });

  it('a MEMBER without sheets.manage gets 403 for preview, mapping, sync and the secret', async () => {
    const member = await h.ctx(h.wsA.memberId, h.wsA.id);
    await expect(previewSheetRows(member, {}, h.deps)).rejects.toMatchObject({ status: 403 });
    await expect(confirmSheetMapping(member, { expectedVersion: 2, headerFingerprint: 'a'.repeat(64), mapping: MAPPING }, h.deps)).rejects.toMatchObject({ status: 403 });
    await expect(requestSheetsSync(member)).rejects.toMatchObject({ status: 403 });
    await expect(issueAppsScriptSecret(member, {}, { keyRing: h.ring })).rejects.toMatchObject({ status: 403 });
  });

  it('the sync job in a DEMO process contacts nobody', async () => {
    const job = getJobContext({ id: 'job_x', workspaceId: h.wsA.id, correlationId: 'c' }, { prisma: h.db, mode: 'demo', clock: h.clock });
    h.google.reset();
    expect(await openSheets(job, h.deps)).toMatchObject({ ok: false, failure: { code: 'SHEETS_LIVE_ONLY' } });
    expect(h.google.requests).toHaveLength(0);
  });
});
