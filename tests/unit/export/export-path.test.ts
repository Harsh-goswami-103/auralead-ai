// T26, ADR-120: a lead export file lives at STORAGE_DIR/exports/<workspaceId>/<exportId>.<format>,
// csv (as before) or xlsx. The path is built only from plain identifiers and a known format, so a
// stored id can never point the writer, the purge or `lead:erase` outside the exports folder.
import { describe, expect, it } from 'vitest';
import { LEAD_EXPORT_FORMATS, leadExportRelPath } from '@/server/services/leads/export';

describe('leadExportRelPath', () => {
  it('names the file by workspace, export id and format', () => {
    expect(LEAD_EXPORT_FORMATS).toEqual(['csv', 'xlsx']);
    expect(leadExportRelPath('ws_a', 'exp_1', 'csv')).toBe('exports/ws_a/exp_1.csv');
    expect(leadExportRelPath('ws_a', 'exp_1', 'xlsx')).toBe('exports/ws_a/exp_1.xlsx');
  });

  it('refuses ids that are not plain identifiers and unknown formats', () => {
    expect(() => leadExportRelPath('../ws', 'exp_1', 'csv')).toThrow();
    expect(() => leadExportRelPath('ws_a', 'exp/1', 'csv')).toThrow();
    expect(() => leadExportRelPath('ws_a', '', 'xlsx')).toThrow();
    expect(() => leadExportRelPath('ws_a', 'exp_1', 'pdf' as never)).toThrow();
    expect(() => leadExportRelPath('ws_a', 'exp_1', '../csv' as never)).toThrow();
  });
});
