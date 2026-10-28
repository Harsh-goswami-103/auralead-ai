/**
 * Inbox thread list (T22 over the Aurora polish pass): the full list keeps every chip (channel,
 * delivery, AI mode, window, what needs a person), while the conversation's narrow side column
 * (`compact`) shows the channel and window as quiet icon + text facts and keeps chips only for what
 * needs a person. Both keep the texts the e2e specs read on the current thread ("Free-form until
 * HH:MM IST", "You are handling"), the data attributes and aria-current on the open thread. The list
 * enters once as a whole, so a refresh that reorders rows replays nothing.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ThreadList } from '@/components/inbox/ThreadList';
import type { InboxThreadRow } from '@/server/services/messaging/inbox';

afterEach(() => cleanup());

const now = new Date('2026-10-20T02:00:00.000Z');

function row(over: Partial<InboxThreadRow>): InboxThreadRow {
  return {
    conversationId: 'conv_wa',
    leadId: 'lead_1',
    leadName: 'Neha Banerjee',
    simulated: true,
    channel: 'WHATSAPP',
    aiMode: 'DRAFT',
    humanTakeover: false,
    lastMessage: { direction: 'OUT', preview: 'Thank you. A member of our team will prepare your quotation.', status: 'SENT', simulated: true, at: now },
    lastActivityAt: new Date(now.getTime() - 3 * 60 * 60 * 1000),
    windowOpen: true,
    windowEndsAt: new Date('2026-10-20T00:00:00.000Z'),
    pendingApprovals: 0,
    attentionDeliveries: 0,
    openCallRequests: 0,
    escalated: false,
    handedOverAt: null,
    readOnly: false,
    needsYou: false,
    ...over,
  };
}

const rows = [
  row({}),
  row({ conversationId: 'conv_mail', channel: 'EMAIL', windowOpen: false, windowEndsAt: null, pendingApprovals: 1, needsYou: true }),
  row({ conversationId: 'conv_takeover', leadName: 'Rohan Saxena', humanTakeover: true, openCallRequests: 1, needsYou: true }),
];

function thread(id: string): HTMLElement {
  return document.querySelector(`[data-thread="${id}"]`) as HTMLElement;
}

describe('ThreadList', () => {
  it('keeps every chip in the full list', () => {
    render(<ThreadList rows={rows} timeZone="Asia/Kolkata" now={now} />);
    const wa = thread('conv_wa');
    expect(wa.getAttribute('data-channel')).toBe('WHATSAPP');
    expect(wa.getAttribute('href')).toBe('/dashboard/user/inbox/conv_wa');
    expect(wa.textContent).toContain('Free-form until 05:30 IST');
    expect(wa.textContent).toContain('AI drafts');
    expect(wa.querySelector('[data-source-chip]')).not.toBeNull();
    expect(wa.querySelector('[data-status-badge]')).not.toBeNull();
    expect(thread('conv_mail').textContent).toContain('1 to approve');
  });

  it('keeps the window and takeover words in the compact side column, with chips only for what needs a person', () => {
    render(<ThreadList rows={rows} activeId="conv_wa" timeZone="Asia/Kolkata" now={now} compact />);
    const current = thread('conv_wa');
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(current.textContent).toContain('Free-form until 05:30 IST');
    expect(within(current).getByText('WhatsApp')).toBeTruthy();
    // The routine state is quiet text: no AI-mode chip, no delivery badge, no source chip.
    expect(current.textContent).not.toContain('AI drafts');
    expect(current.querySelector('[data-status-badge]')).toBeNull();
    expect(current.querySelector('[data-source-chip]')).toBeNull();

    const handled = thread('conv_takeover');
    expect(handled.getAttribute('aria-current')).toBeNull();
    expect(handled.textContent).toContain('You are handling');
    expect(within(handled).getByText('Call requested')).toBeTruthy();

    const mail = thread('conv_mail');
    expect(within(mail).getByText('Email')).toBeTruthy();
    expect(mail.textContent).not.toContain('Window closed');
    expect(within(mail).getByText('1 to approve')).toBeTruthy();
  });

  it('enters once as a list: no row carries an entrance that a reordering refresh could restart', () => {
    render(<ThreadList rows={rows} timeZone="Asia/Kolkata" now={now} />);
    const list = document.querySelector('[data-thread-list]') as HTMLElement;
    // When a thread moves to the top, React re-inserts the unchanged rows above it; a CSS entrance on a
    // row would replay on exactly those rows.
    expect(list.querySelectorAll('[data-reveal]')).toHaveLength(0);
    expect(list.parentElement?.hasAttribute('data-reveal')).toBe(true);
  });

  it('says when a WhatsApp window is closed, in words', () => {
    render(<ThreadList rows={[row({ windowOpen: false, windowEndsAt: null })]} timeZone="Asia/Kolkata" now={now} compact />);
    expect(screen.getByText('Window closed')).toBeTruthy();
  });
});
