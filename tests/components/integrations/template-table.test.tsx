/**
 * ADR-123 (Foundation-A): `WhatsAppTemplate.syncedAt` is nullable, because a template written in
 * the template studio exists before any sync. The template table shows the sync time of a synced
 * template and says "Not synced yet" for one that was never synced, instead of a made-up time.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TemplateTable, type TemplateRow } from '@/components/integrations/TemplateTable';
import { formatDateTime } from '@/lib/format/date';

afterEach(cleanup);

const SYNCED_AT = new Date('2026-10-16T08:30:00.000Z');

const rows: TemplateRow[] = [
  { id: 't1', name: 'welcome_first_touch', language: 'en', category: 'MARKETING', status: 'APPROVED', intent: 'FIRST_TOUCH', variables: ['1'], syncedAt: SYNCED_AT },
  { id: 't2', name: 'brochure_share', language: 'en', category: 'MARKETING', status: 'DRAFT', intent: null, variables: [], syncedAt: null },
];

describe('TemplateTable sync time', () => {
  it('shows the sync time of a synced template and "Not synced yet" for one never synced', () => {
    const { container } = render(<TemplateTable templates={rows} timeZone="Asia/Kolkata" />);
    const synced = container.querySelector('[data-template="welcome_first_touch"]') as HTMLElement;
    const authored = container.querySelector('[data-template="brochure_share"]') as HTMLElement;
    expect(within(synced).getByText(formatDateTime(SYNCED_AT, 'Asia/Kolkata'))).toBeTruthy();
    expect(within(authored).getByText('Not synced yet')).toBeTruthy();
    expect(screen.getAllByText('Not synced yet')).toHaveLength(1);
  });
});
