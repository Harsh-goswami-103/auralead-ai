/**
 * Adversarial review: the Continue / Open link of a recent import keeps a 44 px touch area on
 * phones (the same touchTarget the buttons use); an expired import offers no link.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RecentImports } from '@/components/leads/import/RecentImports';
import type { LeadImportDto } from '@/lib/schemas/lead-import';

afterEach(cleanup);

const dto = (over: Partial<LeadImportDto>): LeadImportDto =>
  ({
    id: 'imp_1', status: 'PREVIEW', effectiveStatus: 'PREVIEW', fileName: 'leads.csv', sheetName: 'leads', rowCount: 5, header: ['Name'], mapping: null, dataSource: null, consentAttested: false,
    counts: { accepted: 0, duplicates: 0, rejected: 0, processed: 0 }, notes: [], createdAt: '2026-10-23T06:00:00.000Z', expiresAt: '2026-10-24T06:00:00.000Z', finishedAt: null, ...over,
  }) as LeadImportDto;

describe('RecentImports links', () => {
  it('Continue has a phone-sized touch area; an expired import has no link', () => {
    render(<RecentImports imports={[dto({}), dto({ id: 'imp_2', status: 'EXPIRED', effectiveStatus: 'EXPIRED' })]} basePath="/dashboard/employee/ws/leads/import" timeZone="Asia/Kolkata" />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]!.className).toContain('max-lg:before:min-h-11');
  });
});
