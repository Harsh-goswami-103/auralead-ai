// Cross-slice (integrator): the lead export honours F5's "handed over" filter. The Leads list filters
// on `?handedOver=1` (ADR-124) and the export panel sends the page's filters, so an export started
// from that view must hold only the handed-over leads, must not be mistaken for the unfiltered
// export that is already in flight (the reuse compares every filter), and is audited with the filter.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildLeadExportRows, requestLeadExport } from '@/server/services/leads/export';
import { createQuoteHarness, makeLeads, ownerCtx, WS_A, type QuoteHarness } from './support';

let h: QuoteHarness;

beforeAll(async () => {
  h = await createQuoteHarness('export-handed-over');
  const [, handed] = await makeLeads(h.db, WS_A, [{ name: 'Still with the operator' }, { name: 'Handed over lead', stage: 'CONVERTED' }, { name: 'Another open lead' }]);
  await h.db.lead.update({ where: { id: handed!.id }, data: { handedOverAt: new Date('2026-10-16T04:00:00.000Z') } });
}, 120_000);

afterAll(async () => {
  await h?.testDb.destroy();
});

afterEach(async () => {
  await h.db.leadExport.updateMany({ where: { status: { in: ['QUEUED', 'READY'] } }, data: { status: 'EXPIRED' } });
});

describe('exporting the handed-over leads', () => {
  it('holds only the handed-over lead when the filter is on, and every lead when it is off', async () => {
    const only = await buildLeadExportRows(h.db, WS_A, { handedOver: true, sort: 'newest' });
    expect(only.rowCount).toBe(1);
    expect(only.rows[0]).toContain('Handed over lead');
    const all = await buildLeadExportRows(h.db, WS_A, { sort: 'newest' });
    expect(all.rowCount).toBe(3);
  });

  it('is a different export from the unfiltered one in flight, and is audited with the filter', async () => {
    const owner = await ownerCtx(h);
    const everyone = await requestLeadExport(owner, { requestKey: 'export-handed-0001', filters: { sort: 'newest' } });
    const handedOver = await requestLeadExport(owner, { requestKey: 'export-handed-0002', filters: { handedOver: true, sort: 'newest' } });
    expect(everyone.created).toBe(true);
    expect(handedOver.created).toBe(true);
    expect(handedOver.export.id).not.toBe(everyone.export.id);
    expect(handedOver.export.filters).toMatchObject({ handedOver: true });
    // The same filter again, with a new request key, reuses the handed-over export.
    const again = await requestLeadExport(owner, { requestKey: 'export-handed-0003', filters: { sort: 'newest', handedOver: true } });
    expect(again).toMatchObject({ created: false, export: { id: handedOver.export.id } });

    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'lead.export.request', targetId: handedOver.export.id } });
    expect(audit.summary).toMatchObject({ filters: { handedOver: true, sort: 'newest' } });
  });
});
