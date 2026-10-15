/**
 * 06-design §11.3: shared state patterns. EmptyState names the situation and offers the next
 * step; ErrorState always shows the correlation ID and never a stack trace or a raw internal
 * error message; LoadingSkeleton is announced as busy; PartialNotice names what failed.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState } from '@/components/patterns/ErrorState';
import { LoadingSkeleton } from '@/components/patterns/LoadingSkeleton';
import { PartialNotice } from '@/components/patterns/PartialNotice';
import { ValidationError } from '@/lib/errors';

afterEach(cleanup);

describe('EmptyState', () => {
  it('renders title, description and the action', () => {
    render(<EmptyState title="No leads yet" description="Leads appear here when a source sends them." action={<a href="/x">Connect a source</a>} />);
    expect(screen.getByRole('heading', { name: 'No leads yet' })).toBeTruthy();
    expect(screen.getByText('Leads appear here when a source sends them.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Connect a source' })).toBeTruthy();
  });
});

describe('ErrorState', () => {
  it('shows the correlation ID and a generic message, never the stack or raw message', () => {
    const err = new Error('SQLITE_CORRUPT at C:\\Users\\secret\\app.db');
    const { container } = render(<ErrorState error={err} correlationId="req_abc123def456" />);
    expect(screen.getByRole('alert')).toBeTruthy();
    const text = container.textContent ?? '';
    expect(text).toContain('req_abc123def456');
    expect(text).not.toContain('SQLITE_CORRUPT');
    expect(text).not.toContain(err.stack!.split('\n')[1]!.trim());
    expect(text).not.toMatch(/\bat\s+\S+\s+\(/);
    expect(text).toContain('Something went wrong');
  });

  it('uses the AppError user message when there is one', () => {
    const err = new ValidationError({ userMessage: 'The discount is above your limit.' });
    const { container } = render(<ErrorState error={err} correlationId="req_zzz999yyy888" />);
    const text = container.textContent ?? '';
    expect(text).toContain('The discount is above your limit.');
    expect(text).not.toContain(err.stack!.split('\n')[1]!.trim());
  });

  it('accepts a plain message and runs retry', () => {
    const retry = vi.fn();
    render(<ErrorState title="Metrics unavailable" message="This tile could not load." correlationId="req_retry0001" onRetry={retry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Metrics unavailable')).toBeTruthy();
    expect(screen.getByText('This tile could not load.')).toBeTruthy();
  });
});

describe('LoadingSkeleton', () => {
  it('is announced as busy and renders the requested rows', () => {
    const { container } = render(<LoadingSkeleton rows={4} label="Loading leads" />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('Loading leads')).toBeTruthy();
    expect(container.querySelectorAll('[data-skeleton-row]').length).toBe(4);
  });
});

describe('PartialNotice', () => {
  it('names the parts that failed', () => {
    render(<PartialNotice title="Some metrics could not load" items={['Open conversations', 'Pipeline value']} />);
    expect(screen.getByText('Some metrics could not load')).toBeTruthy();
    expect(screen.getByText('Open conversations')).toBeTruthy();
    expect(screen.getByText('Pipeline value')).toBeTruthy();
  });
});
