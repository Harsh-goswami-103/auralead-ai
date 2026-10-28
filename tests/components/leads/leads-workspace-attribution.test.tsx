/**
 * ADR-118 (b), adversarial review: a list or board that shows a LIVE Google Places lead names
 * "Google Maps" and carries the terms line once above the rows; a list without one does not, and a
 * simulated (DEMO) Places lead is not Google content.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeadsWorkspace, type LeadsWorkspaceProps } from '@/components/leads/LeadsWorkspace';
import type { LeadRowDto } from '@/components/leads/types';
import { CsrfProvider } from '@/components/patterns/csrf';
import { parseLeadPageParams } from '@/lib/schemas/leads';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(cleanup);

const row = (over: Partial<LeadRowDto>): LeadRowDto => ({
  id: 'l1', displayName: 'Royal Dental', city: 'Indore', category: 'Dentist', phoneE164: '+917314002002', emailNormalized: null, firstSource: 'GOOGLE_PLACES',
  salesStage: 'NEW', stageVersion: 0, score: 40, simulated: false, createdAt: '2026-10-16T06:00:00.000Z', href: '/dashboard/user/leads?lead=l1', ...over,
});

function props(rows: LeadRowDto[], over: Partial<LeadsWorkspaceProps> = {}): LeadsWorkspaceProps {
  return {
    basePath: '/dashboard/user/leads',
    params: parseLeadPageParams({}),
    timeZone: 'Asia/Kolkata',
    moveGate: null,
    exportGate: null,
    list: { rows, total: { count: rows.length, capped: false }, nextCursor: null, prevCursor: null },
    board: null,
    exports: [],
    cursorReset: false,
    emptyWorkspace: null,
    ...over,
  } as LeadsWorkspaceProps;
}

const view = (p: LeadsWorkspaceProps) => render(<CsrfProvider token="t"><LeadsWorkspace {...p} /></CsrfProvider>);

describe('Google Maps attribution on the Leads list', () => {
  it('shows it once above a table with a LIVE Places lead', () => {
    view(props([row({}), row({ id: 'l2', displayName: 'Second Dental' })]));
    expect(document.querySelectorAll('[data-places-attribution="google"]')).toHaveLength(1);
    expect(screen.getByText('Google Maps')).toBeTruthy();
    expect(document.querySelector('[data-google-terms]')?.textContent).toContain('Results from Google Maps.');
  });

  it('shows no Google attribution for other sources or for a simulated Places lead', () => {
    view(props([row({ firstSource: 'META_ADS' }), row({ id: 'l3', simulated: true })]));
    expect(document.querySelector('[data-places-attribution="google"]')).toBeNull();
  });

  it('also shows it above the board', () => {
    const columns = [{ stage: 'NEW' as const, rows: [row({})], total: { count: 1, capped: false } }];
    view(props([], { list: null, board: { columns, total: { count: 1, capped: false } } }));
    expect(document.querySelector('[data-places-attribution="google"]')).not.toBeNull();
  });
});
