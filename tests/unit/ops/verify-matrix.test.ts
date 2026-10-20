/**
 * T38 / P18: `npm run verify` prints the integration evidence matrix of docs/integrations.md and
 * refuses a live-verified claim without evidence. The parser is exercised on synthetic text and on
 * the real file, so "no invalid rows" means something was parsed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkLiveEvidence, parseEvidenceMatrix, STEPS } from '../../../scripts/verify.mjs';

const TABLE = `# Integrations

## Status matrix

| Integration | Implemented | Fixture-tested | Demo-verified | Live-verified |
|---|---|---|---|---|
| WhatsApp Cloud API | Yes | Yes | Yes | No |
| Resend | Yes | Yes | Yes | 2026-11-02 docs/evidence/resend-live.md |

## Documentation check log

| not | a | matrix | row | here |
`;

describe('parseEvidenceMatrix', () => {
  it('reads one row per integration and stops at the next section', () => {
    const rows = parseEvidenceMatrix(TABLE);
    expect(rows).toEqual([
      { integration: 'WhatsApp Cloud API', implemented: 'Yes', fixtureTested: 'Yes', demoVerified: 'Yes', liveVerified: 'No' },
      { integration: 'Resend', implemented: 'Yes', fixtureTested: 'Yes', demoVerified: 'Yes', liveVerified: '2026-11-02 docs/evidence/resend-live.md' },
    ]);
  });

  it('returns nothing when there is no matrix', () => {
    expect(parseEvidenceMatrix('# nothing here')).toEqual([]);
  });
});

describe('checkLiveEvidence', () => {
  const row = (liveVerified: string) => ({ integration: 'X', implemented: 'Yes', fixtureTested: 'Yes', demoVerified: 'Yes', liveVerified });

  it('accepts "No" as an honest statement', () => {
    expect(checkLiveEvidence(row('No'))).toEqual({ ok: true, claimed: false });
  });

  it('accepts a dated claim only when its evidence file exists', () => {
    expect(checkLiveEvidence(row('2026-11-02 docs/evidence/a.md'), () => true)).toEqual({ ok: true, claimed: true });
    const missing = checkLiveEvidence(row('2026-11-02 docs/evidence/a.md'), () => false);
    expect(missing).toMatchObject({ ok: false, claimed: true });
  });

  it('rejects a bare "Yes" or an undated claim', () => {
    expect(checkLiveEvidence(row('Yes'))).toMatchObject({ ok: false });
    expect(checkLiveEvidence(row('docs/evidence/a.md'), () => true)).toMatchObject({ ok: false });
  });
});

describe('the real docs/integrations.md', () => {
  const rows = parseEvidenceMatrix(readFileSync(path.resolve(import.meta.dirname, '../../../docs/integrations.md'), 'utf8'));

  it('has a row for every provider and only honest live-verified cells', () => {
    expect(rows.map((r) => r.integration)).toEqual(
      expect.arrayContaining(['WhatsApp Cloud API (send, templates, media)', 'Meta Lead Ads webhook and lead fetch', 'Resend (email send, webhooks)', 'Google Sheets and Apps Script', 'Anthropic (drafts)']),
    );
    for (const row of rows) expect(checkLiveEvidence(row), row.integration).toMatchObject({ ok: true });
  });
});

describe('STEPS', () => {
  it('covers every gate of the acceptance run, in order, with unique ids', () => {
    expect(STEPS.map((s) => s.id)).toEqual(['typecheck', 'lint', 'test', 'audit', 'e2e', 'fresh']);
  });
});
