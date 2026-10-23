/**
 * ADR-120 and R1 (DEMO zero outbound): a whole file import in DEMO (upload, preview, confirm with
 * an attested opt-in column, both chunk jobs, the purge) and the sample workbook and an Excel lead
 * export make no outbound attempt: no fetch, no socket, no TLS, no DNS lookup.
 */
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { consentAttestationText } from '@/lib/schemas/lead-import';
import { outboundAttempts, resetOutboundAttempts } from '@/server/adapters/http/outbound';
import { buildLeadImportSampleWorkbook, confirmLeadImport } from '@/server/services/leads/import';
import { buildLeadExportFile } from '@/server/services/leads/export';
import { businessRows, createImportHarness, csvUpload, ownerOf, upload, WS_A, type ImportHarness } from './support';

let h: ImportHarness;
const counters = { connect: 0, tls: 0, lookup: 0, fetch: 0 };

beforeAll(async () => {
  h = await createImportHarness('import-tripwire');
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket) {
    counters.connect += 1;
    throw new Error('tripwire: socket connect attempted');
  });
  vi.spyOn(tls, 'connect').mockImplementation(() => {
    counters.tls += 1;
    throw new Error('tripwire: tls connect attempted');
  });
  vi.spyOn(dns, 'lookup').mockImplementation((() => {
    counters.lookup += 1;
    throw new Error('tripwire: dns lookup attempted');
  }) as never);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    counters.fetch += 1;
    throw new Error('tripwire: fetch attempted');
  });
  resetOutboundAttempts();
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await h?.cleanup();
});

describe('DEMO file import tripwire', () => {
  it('imports 250 rows with opt-ins and exports Excel without any outbound attempt', async () => {
    const owner = await ownerOf(h);
    const rows = businessRows(250, 'Tripwire Shop', 40_000).map((r, i) => [r[0]!, r[1]!, i % 2 === 0 ? 'yes' : '', i % 2 === 0 ? '14/09/2026' : '']);
    const { import: created } = await upload(h, owner, csvUpload([['Name', 'Phone', 'Opt in', 'Opt-in date'], ...rows], 'tripwire-0001'));
    const business = 'Smile Avenue Dental Clinic';
    await confirmLeadImport(
      owner,
      created.id,
      { mapping: { name: 0, phone: 1, consent: 2, consentDate: 3 }, dataSource: 'OWN_CUSTOMERS', consent: { noticeText: `${business} sends offers on WhatsApp.`, attestation: consentAttestationText(business) } },
      { storageDir: h.storageDir },
    );
    await h.drain();
    expect(await h.db.leadImport.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ status: 'SUCCEEDED', accepted: 250, consentRecorded: 125 });
    expect(buildLeadImportSampleWorkbook().length).toBeGreaterThan(0);
    expect((await buildLeadExportFile(h.db, WS_A, { sort: 'newest' }, 'xlsx')).rowCount).toBeGreaterThanOrEqual(250);

    expect(outboundAttempts()).toEqual([]);
    expect(counters).toEqual({ connect: 0, tls: 0, lookup: 0, fetch: 0 });
  });
});
