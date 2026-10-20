/**
 * T26, R14, R4, R12: the lead detail sections. ScoreBreakdown lists each known input with points
 * out of its weight, the unknown inputs scored 0 and the fixed "heuristic, not intent or consent"
 * caption with the config version. ConsentChips shows one icon + label chip per channel (an opt-out
 * reads "Opted out", a missing contact says which), with the evidence time and source, and states
 * that consent is separate from the stage. SourceRecords shows the source, outcome and attribution
 * but never the raw payload. The CSV labels stay in step with the panel's vocabulary.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConsentChips } from '@/components/leads/ConsentChips';
import { SALES_STAGE_VOCABULARY, WEBSITE_LABELS } from '@/components/leads/lead-vocabulary';
import { ScoreBreakdown } from '@/components/leads/ScoreBreakdown';
import { SourceRecords } from '@/components/leads/SourceRecords';
import { sourceStyle } from '@/components/patterns/source-style';
import { LeadSource, SalesStage, WebsiteStatus } from '@/lib/domain/enums';
import { SCORE_CAPTION } from '@/lib/schemas/scoring';
import { LEAD_SOURCE_CSV_LABELS, SALES_STAGE_CSV_LABELS, WEBSITE_STATUS_CSV_LABELS } from '@/server/services/leads/csv';

afterEach(cleanup);

describe('ScoreBreakdown', () => {
  it('explains the stored score exactly', () => {
    render(
      <ScoreBreakdown
        score={35}
        configVersion={2}
        reasons={[
          { input: 'phonePresent', label: 'Phone on record', points: 15, maxPoints: 15 },
          { input: 'rating', label: 'Rated 4.0 of 5', points: 16, maxPoints: 20 },
          { input: 'emailPresent', label: 'No email on record', points: 0, maxPoints: 10 },
          { input: 'sourceIntent', label: 'Came in through a form or an inbound message', points: 4, maxPoints: 5 },
        ]}
        unknownInputs={[{ input: 'websiteStatus', label: 'Website: unknown, not verified absent' }]}
      />,
    );
    expect(screen.getByText('35 / 100')).toBeTruthy();
    const reasons = screen.getByRole('list', { name: 'Score reasons' });
    expect(within(reasons).getAllByRole('listitem')).toHaveLength(4);
    expect(within(reasons).getByText('16 / 20')).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Unknown inputs' })).getByText('Website: unknown, not verified absent')).toBeTruthy();
    expect(screen.getByText(`${SCORE_CAPTION} Scoring configuration v2.`)).toBeTruthy();
  });

  it('says when a lead is not scored', () => {
    render(<ScoreBreakdown score={null} configVersion={null} reasons={[]} unknownInputs={[]} />);
    expect(screen.getByText('Not scored')).toBeTruthy();
    expect(screen.getByText('No scoring reasons recorded yet.')).toBeTruthy();
  });
});

describe('ConsentChips', () => {
  it('one icon + label chip per channel with evidence time and source', () => {
    const { container } = render(
      <ConsentChips
        timeZone="Asia/Kolkata"
        consent={[
          { channel: 'WHATSAPP', state: 'OPT_IN', since: '2026-10-15T05:00:00.000Z', source: 'SHEETS_FORM' },
          { channel: 'EMAIL', state: 'OPTED_OUT', since: '2026-10-16T06:00:00.000Z', source: 'UNSUBSCRIBE' },
        ]}
      />,
    );
    const wa = container.querySelector('[data-consent-channel="WHATSAPP"]') as HTMLElement;
    expect(wa.querySelector('[data-tone="success"]')?.textContent).toBe('Opt-in on record');
    expect(wa.querySelector('[data-tone="success"] svg')).not.toBeNull();
    expect(wa.textContent).toContain('Evidence from 15 Oct 2026');
    expect(wa.textContent).toContain('Google Sheets form answer');
    const email = container.querySelector('[data-consent-channel="EMAIL"]') as HTMLElement;
    expect(email.querySelector('[data-tone="danger"]')?.textContent).toBe('Opted out');
    expect(email.textContent).toContain('Unsubscribe link');
    expect(screen.getByText('Consent is separate from the sales stage. Every send is checked again at dispatch.')).toBeTruthy();
  });

  it('names a missing contact per channel and every other state', () => {
    const { container } = render(
      <ConsentChips
        timeZone="Asia/Kolkata"
        consent={[
          { channel: 'WHATSAPP', state: 'NO_CONTACT', since: null, source: null },
          { channel: 'EMAIL', state: 'B2B_ATTESTED', since: null, source: 'EMPLOYEE_ATTESTATION' },
        ]}
      />,
    );
    expect(container.querySelector('[data-consent-channel="WHATSAPP"]')?.textContent).toContain('No phone number on record');
    expect(container.querySelector('[data-consent-channel="EMAIL"]')?.textContent).toContain('B2B basis attested (manual sends only)');
    cleanup();
    render(<ConsentChips timeZone="Asia/Kolkata" consent={[{ channel: 'WHATSAPP', state: 'CUSTOMER_MESSAGED', since: null, source: 'INBOUND_MESSAGE' }, { channel: 'EMAIL', state: 'NONE', since: null, source: null }]} />);
    expect(screen.getByText('Customer messaged first')).toBeTruthy();
    expect(screen.getByText('No opt-in')).toBeTruthy();
  });
});

describe('SourceRecords', () => {
  it('shows the source, outcome, batch and attribution; never the raw payload', () => {
    render(
      <SourceRecords
        timeZone="Asia/Kolkata"
        records={[
          {
            id: 'sr1',
            source: 'META_ADS',
            status: 'ACCEPTED',
            reasonCode: null,
            externalId: 'leadgen-1',
            receivedAt: '2026-10-16T06:00:00.000Z',
            extractedAt: null,
            mappingVersion: 2,
            attribution: [
              { key: 'campaign', value: 'Diwali offer' },
              { key: 'adId', value: '12' },
            ],
            batch: { externalBatchId: 'meta:page:lead-1', simulated: true },
          },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'Source records' });
    expect(within(list).getByText('Meta Lead Ads')).toBeTruthy();
    expect(within(list).getByText('Created this lead')).toBeTruthy();
    expect(within(list).getByText('Campaign')).toBeTruthy();
    expect(within(list).getByText('Diwali offer')).toBeTruthy();
    expect(within(list).getByText('Ad id')).toBeTruthy();
    expect(within(list).getByText('Version 2')).toBeTruthy();
    expect(within(list).getByText('Simulated')).toBeTruthy();
  });

  it('says when no record is linked', () => {
    render(<SourceRecords timeZone="Asia/Kolkata" records={[]} />);
    expect(screen.getByText(/No source record is linked/)).toBeTruthy();
  });
});

describe('CSV labels follow the panel vocabulary', () => {
  it('stages, sources and website states read the same in the CSV and on screen', () => {
    for (const s of SalesStage) expect(SALES_STAGE_CSV_LABELS[s]).toBe(SALES_STAGE_VOCABULARY[s]!.label);
    for (const s of LeadSource) expect(LEAD_SOURCE_CSV_LABELS[s]).toBe(sourceStyle(s).label);
    for (const s of WebsiteStatus) expect(WEBSITE_STATUS_CSV_LABELS[s]).toBe(WEBSITE_LABELS[s]);
  });
});
