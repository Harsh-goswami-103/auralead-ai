/**
 * Quote state timeline (user report bug "raw audit codes in the timeline"): every audit action the
 * quote services emit has a human label, the version stays in the same element as the label
 * ("Sent (v1)", which the manual-share e2e matches exactly), and an action without a label falls
 * back to humanised words, so no dotted code ever reaches the screen. Also the client-panel wording
 * helpers: "1 day", not "1 days", and generator ids shown by name.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { QuoteTimeline, quoteAuditLabel } from '@/components/client/QuoteTimeline';
import { days, generatorLabel, plural } from '@/components/client/labels';

afterEach(cleanup);

describe('QuoteTimeline', () => {
  it('labels every emitted audit action and never shows a dotted code', () => {
    render(
      <QuoteTimeline
        items={[
          { id: 'a1', action: 'quote.create', versionNo: 1, when: '19 Oct, 10:00 IST', who: 'Owner' },
          { id: 'a2', action: 'quote.pdf.render', versionNo: 1, when: '19 Oct, 10:01 IST', who: 'Scheduled job' },
          { id: 'a3', action: 'quote.send', versionNo: 1, when: '19 Oct, 10:05 IST', who: 'Owner' },
          { id: 'a4', action: 'quote.sent_superseded_version', versionNo: 2, when: '19 Oct, 11:00 IST', who: 'Owner' },
          { id: 'a5', action: 'quote.reminder.queued', versionNo: null, when: '19 Oct, 12:00 IST', who: 'Scheduled job' },
        ]}
      />,
    );
    const list = screen.getByRole('list');
    expect(screen.getByText('Created as a draft (v1)')).toBeTruthy();
    expect(screen.getByText('PDF ready (v1)')).toBeTruthy();
    expect(screen.getByText(/^Sent \(v1\)$/)).toBeTruthy();
    expect(screen.getByText('An older version was sent (v2)')).toBeTruthy();
    expect(screen.getByText('Reminder queued')).toBeTruthy();
    expect(list.textContent).not.toMatch(/quote\.[a-z]/);
  });

  it('falls back to words for unknown actions', () => {
    expect(quoteAuditLabel('quote.view')).toBe('Opened (may be automated)');
    expect(quoteAuditLabel('quote.share.revoke')).toBe('Share link revoked');
    expect(quoteAuditLabel('quote.some_new.thing')).toBe('Some new thing');
    expect(quoteAuditLabel('')).toBe('Updated');
  });
});

describe('client wording helpers', () => {
  it('pluralises counts and names generators', () => {
    expect(days(1)).toBe('1 day');
    expect(days(15)).toBe('15 days');
    expect(plural(1, 'person', 'people')).toBe('1 person');
    expect(plural(10000, 'unit', 'units')).toBe('10,000 units');
    expect(generatorLabel('local-deterministic')).toBe('Local template (deterministic)');
    expect(generatorLabel('some-new-model')).toBe('Some new model');
  });
});
