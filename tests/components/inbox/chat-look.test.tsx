/**
 * ADR-121 WhatsApp-like look of the timeline and thread list (both panels):
 * - outgoing ticks keep their words (Queued, Sent, Delivered, Read in the read hue, Failed);
 * - bubbles use the chat skin on the wallpaper; template messages show the document name, body with
 *   values, footer and buttons;
 * - automated replies carry their provenance, and only a model provider reads as AI;
 * - the handoff (ADR-124) is a timeline pill;
 * - the thread list links into the panel's inbox (`basePath`) and marks Needs you, escalations and
 *   handed-over leads in words.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ThreadList } from '@/components/inbox/ThreadList';
import { ThreadTimeline } from '@/components/inbox/ThreadTimeline';
import type { InboxThreadRow, ThreadMessage } from '@/server/services/messaging/inbox';

afterEach(() => cleanup());

const at = new Date('2026-10-20T06:00:00.000Z');

function message(id: string, over: Partial<ThreadMessage>): ThreadMessage {
  return {
    id,
    direction: 'OUT',
    kind: 'TEXT',
    body: `Reply ${id}`,
    subject: null,
    templateName: null,
    template: null,
    quote: null,
    quickReply: null,
    quickReplyLabel: null,
    status: 'SENT',
    statusLabel: 'Sent',
    simulated: false,
    generatorLabel: 'human',
    sendIntent: 'MANUAL_SINGLE',
    automated: false,
    at,
    approval: null,
    attempt: null,
    deferredUntil: null,
    note: null,
    ...over,
  };
}

function renderTimeline(messages: ThreadMessage[], events: Parameters<typeof ThreadTimeline>[0]['events'] = []) {
  render(<ThreadTimeline messages={messages} events={events} timeZone="Asia/Kolkata" draftActions={() => null} />);
}

const item = (id: string) => document.querySelector(`[data-message="${id}"]`) as HTMLElement;
const tick = (id: string) => item(id).querySelector('[data-delivery-tick]');

describe('ThreadTimeline', () => {
  it('ticks keep their words: Queued, Sent, Delivered, Read (read hue), Failed; inbound has none', () => {
    renderTimeline([
      message('m_in', { direction: 'IN', status: 'DELIVERED', statusLabel: 'Delivered', generatorLabel: null, body: 'Hello', sendIntent: null }),
      message('m_pending', { status: 'PENDING', statusLabel: 'Queued' }),
      message('m_sent', {}),
      message('m_delivered', { status: 'DELIVERED', statusLabel: 'Delivered' }),
      message('m_read', { status: 'READ', statusLabel: 'Read' }),
      message('m_failed', { status: 'FAILED', statusLabel: 'Failed' }),
    ]);
    expect(tick('m_in')).toBeNull();
    expect(tick('m_pending')?.textContent).toBe('Queued');
    expect(tick('m_sent')?.textContent).toBe('Sent');
    expect(tick('m_delivered')?.textContent).toBe('Delivered');
    expect(tick('m_read')?.textContent).toBe('Read');
    expect(tick('m_read')?.querySelector('svg')?.getAttribute('class')).toContain('text-chat-tick-read');
    expect(tick('m_delivered')?.querySelector('svg')?.getAttribute('class')).not.toContain('text-chat-tick-read');
    expect(tick('m_failed')?.textContent).toBe('Failed');
    expect(document.querySelector('[data-chat-wallpaper]')?.className).toContain('bg-chat-wallpaper');
    expect(item('m_sent').querySelector('[data-bubble]')?.className).toContain('bg-chat-bubble-out');
    expect(item('m_in').querySelector('[data-bubble]')?.className).toContain('bg-chat-bubble-in');
  });

  it('a draft has no tick and no status label (nothing was sent)', () => {
    renderTimeline([message('m_draft', { status: 'DRAFT', statusLabel: 'Draft', sendIntent: null })]);
    expect(item('m_draft').querySelector('[data-status-label]')).toBeNull();
  });

  it('a template message shows its document name, body with values, footer and buttons', () => {
    renderTimeline([
      message('m_tpl', {
        kind: 'TEMPLATE',
        body: null,
        status: 'READ',
        statusLabel: 'Read',
        templateName: 'brochure_share',
        template: { headerFormat: 'DOCUMENT', headerText: null, documentName: 'codecraft-brochure.pdf', body: 'Hi Priya, here is our brochure.', footer: 'Reply STOP to opt out', buttons: [{ type: 'QUICK_REPLY', text: 'Stop promotions' }] },
      }),
      message('m_text_header', {
        kind: 'TEMPLATE',
        body: null,
        templateName: 'welcome',
        template: { headerFormat: 'TEXT', headerText: 'Welcome to Codecraft', documentName: null, body: 'We build websites.', footer: null, buttons: [] },
      }),
    ]);
    expect(item('m_tpl').querySelector('[data-template-document]')?.textContent).toBe('codecraft-brochure.pdf');
    expect(item('m_tpl').textContent).toContain('Hi Priya, here is our brochure.');
    expect(item('m_tpl').textContent).toContain('Reply STOP to opt out');
    expect(item('m_tpl').querySelector('[data-template-buttons]')?.textContent).toBe('Stop promotions');
    expect(item('m_text_header').textContent).toContain('Welcome to Codecraft');
    expect(item('m_text_header').querySelector('[data-template-buttons]')).toBeNull();
  });

  it('automated replies carry their provenance; only a model provider is AI', () => {
    const auto = { automated: true, sendIntent: 'AUTOMATED' as const };
    renderTimeline([
      message('m_ai', { ...auto, generatorLabel: 'anthropic' }),
      message('m_local', { ...auto, generatorLabel: 'local-deterministic' }),
      message('m_guard', { ...auto, generatorLabel: 'reply-guard' }),
      message('m_pipeline', { ...auto, generatorLabel: 'system' }),
    ]);
    expect(item('m_ai').querySelector('[data-generator="ai"]')?.textContent).toBe('AI prepared');
    expect(item('m_local').textContent).toContain('Local template');
    expect(item('m_local').querySelector('[data-generator="ai"]')).toBeNull();
    expect(item('m_guard').textContent).toContain('Automatic reply');
    expect(item('m_pipeline').textContent).toContain('Automated');
  });

  it('the handoff and the day separator are pills on the wallpaper', () => {
    renderTimeline([message('m_1', {})], [{ id: 'h1', at: new Date(at.getTime() + 60_000), kind: 'HANDOFF', label: 'Handed over to Codecraft Web Studio by Riya Sharma.' }]);
    expect(document.querySelector('[data-thread-event="HANDOFF"]')?.textContent).toContain('Handed over to Codecraft Web Studio by Riya Sharma.');
    expect(document.querySelectorAll('[data-thread-day]')).toHaveLength(1);
  });
});

const now = new Date('2026-10-20T02:00:00.000Z');

function row(over: Partial<InboxThreadRow>): InboxThreadRow {
  return {
    conversationId: 'conv_wa',
    leadId: 'lead_1',
    leadName: 'Neha Banerjee',
    simulated: true,
    channel: 'WHATSAPP',
    aiMode: 'AUTO',
    humanTakeover: false,
    lastMessage: { direction: 'OUT', preview: 'Here is what we offer', status: 'READ', simulated: true, at: now },
    lastActivityAt: now,
    windowOpen: true,
    windowEndsAt: new Date('2026-10-20T20:00:00.000Z'),
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

const threadRow = (id: string) => document.querySelector(`[data-thread="${id}"]`) as HTMLElement;

describe('ThreadList', () => {
  it('links into the basePath and marks Needs you, escalations and handed-over leads in words', () => {
    render(
      <ThreadList
        rows={[row({ conversationId: 'conv_esc', escalated: true, needsYou: true }), row({ conversationId: 'conv_ho', handedOverAt: new Date('2026-10-19T10:00:00.000Z') })]}
        timeZone="Asia/Kolkata"
        now={now}
        basePath="/dashboard/employee/codecraft-web/inbox"
      />,
    );
    expect(threadRow('conv_esc').getAttribute('href')).toBe('/dashboard/employee/codecraft-web/inbox/conv_esc');
    expect(threadRow('conv_esc').querySelector('[data-needs-you]')?.textContent).toBe('Needs you');
    expect(threadRow('conv_esc').querySelector('[data-escalated]')?.textContent).toBe('Escalated');
    expect(threadRow('conv_ho').querySelector('[data-handed-over]')?.textContent).toBe('Handed over');
    expect(threadRow('conv_ho').querySelector('[data-needs-you]')).toBeNull();
  });

  it("a handed-over lead is the client's: the operator's row says Handed over and neither Needs you nor You are handling", () => {
    const handedOver = { humanTakeover: true, handedOverAt: new Date('2026-10-19T10:00:00.000Z'), readOnly: true, escalated: true, needsYou: false } as const;
    for (const compact of [false, true]) {
      render(<ThreadList rows={[row({ conversationId: 'conv_ro', ...handedOver })]} timeZone="Asia/Kolkata" now={now} compact={compact} />);
      const ro = threadRow('conv_ro');
      expect(ro.querySelector('[data-handed-over]')?.textContent).toBe('Handed over');
      expect(ro.querySelector('[data-needs-you]')).toBeNull();
      expect(ro.querySelector('[data-escalated]')).toBeNull();
      expect(ro.textContent).not.toContain('You are handling');
      cleanup();
    }
    // The client's own row for the same lead (not read-only) keeps the takeover words.
    render(<ThreadList rows={[row({ conversationId: 'conv_client', ...handedOver, readOnly: false, needsYou: true })]} timeZone="Asia/Kolkata" now={now} />);
    expect(threadRow('conv_client').textContent).toContain('You are handling');
    expect(threadRow('conv_client').querySelector('[data-needs-you]')?.textContent).toBe('Needs you');
  });

  it('shows the last outbound message with its tick and words, the time, and the open window in the chat accent', () => {
    render(<ThreadList rows={[row({})]} timeZone="Asia/Kolkata" now={now} compact />);
    const wa = threadRow('conv_wa');
    expect(wa.querySelector('[data-delivery-tick="READ"]')?.textContent).toBe('Read');
    expect(wa.querySelector('[data-thread-time]')?.textContent).toBe('07:30 IST');
    expect(wa.querySelector('[data-window-open]')?.className).toContain('text-chat-accent');
    expect(wa.textContent).toContain('Free-form until 01:30 IST, 21 Oct');
  });
});
