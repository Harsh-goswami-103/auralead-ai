/**
 * Approval queue rows (T22, employee report bugs 1, 4 and 5): only a real AI provider's text is
 * labelled "AI prepared" (the local template, the reply guard and system texts say what they are,
 * a person's text has no chip); keyboard focus is never suppressed on a row (the 2px outline is
 * drawn inside the row so the rounded list cannot clip it); long previews are clamped; decided rows
 * show approval and dispatch status as icon + label chips and keep data-dispatch-state.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { QueueList } from '@/components/approvals/QueueList';
import type { ApprovalQueueItem } from '@/server/services/approvals/queue';

afterEach(cleanup);

const NOW = new Date('2026-10-19T12:00:00Z');

function message(id: string, generatorLabel: string | null, extra: Partial<ApprovalQueueItem> = {}): ApprovalQueueItem {
  return {
    id,
    kind: 'OUTBOUND_MESSAGE',
    status: 'PENDING',
    flags: ['pipeline_first_touch'],
    requestedAt: new Date('2026-10-19T09:00:00Z'),
    decidedAt: null,
    decidedByName: null,
    invalidationReason: null,
    lead: { id: `lead_${id}`, displayName: `Lead ${id}` },
    quote: null,
    message: {
      id: `msg_${id}`,
      channel: 'EMAIL',
      kind: 'TEXT',
      preview: 'Hi Riya, good to hear you are looking into a consultation. We would be happy to prepare…',
      subject: `Subject ${id}`,
      generatorLabel,
      status: 'DRAFT',
      simulated: true,
      conversationId: `conv_${id}`,
    },
    dispatch: null,
    ...extra,
  } as ApprovalQueueItem;
}

function quote(id: string, extra: Partial<ApprovalQueueItem> = {}): ApprovalQueueItem {
  return {
    ...message(id, null),
    kind: 'QUOTE_VERSION',
    flags: [],
    message: null,
    quote: {
      id: `q_${id}`,
      number: 'Q-0003',
      versionNo: 2,
      currentVersionNo: 2,
      isCurrent: true,
      status: 'DRAFT',
      effectiveStatus: 'DRAFT',
      totalPaise: 94_400n,
      needsPricingReview: false,
      pdfReady: true,
    },
    ...extra,
  } as ApprovalQueueItem;
}

function renderList(items: ApprovalQueueItem[], decided = false) {
  return render(<QueueList items={items} href={(i) => `/q/${i.id}`} now={NOW} timeZone="Asia/Kolkata" decided={decided} />);
}

const row = (id: string) => document.querySelector(`[data-approval-item="${id}"]`) as HTMLElement;

describe('QueueList', () => {
  it('labels only real AI providers as "AI prepared"', () => {
    renderList([
      message('anthropic', 'anthropic'),
      message('openai', 'openai'),
      message('local', 'local-deterministic'),
      message('guard', 'reply-guard'),
      message('system', 'system'),
      message('human', 'human'),
      message('none', null),
    ]);
    expect(within(row('anthropic')).getByText('AI prepared')).toBeTruthy();
    expect(within(row('openai')).getByText('AI prepared')).toBeTruthy();
    expect(within(row('local')).queryByText('AI prepared')).toBeNull();
    expect(within(row('local')).getByText('Local template')).toBeTruthy();
    expect(within(row('guard')).queryByText('AI prepared')).toBeNull();
    expect(within(row('guard')).getByText('Automatic reply')).toBeTruthy();
    expect(within(row('system')).getByText('System text')).toBeTruthy();
    expect(row('human').querySelector('[data-generator]')).toBeNull();
    expect(row('none').querySelector('[data-generator]')).toBeNull();
    expect(screen.getAllByText('AI prepared')).toHaveLength(2);
  });

  it('never suppresses the keyboard focus outline on a row and draws it inside the row', () => {
    renderList([message('a', 'local-deterministic'), quote('b')]);
    for (const id of ['a', 'b']) {
      const link = row(id);
      expect(link.tagName).toBe('A');
      expect(link.className).not.toMatch(/outline-none/);
      expect(link.className).toMatch(/focus-visible:-outline-offset-2/);
      // transition-colors would also fade the outline color in from the text color.
      expect(link.className).not.toMatch(/transition-colors|transition-all/);
    }
  });

  it('keeps the quotation title, total and PDF state; clamps message previews; flags in words', () => {
    renderList([quote('q'), message('m', 'local-deterministic')]);
    expect(row('q').textContent).toContain('Q-0003 v2');
    expect(row('q').textContent).toMatch(/₹944\.00/);
    expect(within(row('q')).getByText('PDF ready')).toBeTruthy();
    expect(within(row('q')).getByText('Quotation')).toBeTruthy();
    const preview = within(row('m')).getByText(/good to hear you are looking/).closest('.line-clamp-2');
    expect(preview).not.toBeNull();
    expect(within(row('m')).getByText('First message from the pipeline')).toBeTruthy();
    expect(document.querySelector('[data-approval-queue="pending"]')).not.toBeNull();
  });

  it('decided rows: approval and dispatch as icon + label chips, data-dispatch-state kept', () => {
    renderList(
      [
        quote('sent', {
          status: 'APPROVED',
          decidedAt: new Date('2026-10-19T10:00:00Z'),
          decidedByName: 'Imran Qureshi',
          dispatch: { state: 'SENT', channel: 'EMAIL', reasonCode: null, reasonLabel: null, deferredUntil: null },
        }),
        quote('rejected', { status: 'REJECTED', decidedAt: new Date('2026-10-19T10:00:00Z'), decidedByName: null }),
      ],
      true,
    );
    const dispatch = row('sent').querySelector('[data-dispatch-state="SENT"]') as HTMLElement;
    expect(dispatch).not.toBeNull();
    expect(dispatch.textContent).toContain('Sent');
    expect(dispatch.querySelector('svg')).not.toBeNull();
    const approved = within(row('sent')).getByText('Approved');
    expect(approved.closest('[data-tone="success"]')?.querySelector('svg')).not.toBeNull();
    expect(row('sent').textContent).toContain('by Imran Qureshi');
    expect(within(row('rejected')).getByText('Rejected').closest('[data-tone="danger"]')).not.toBeNull();
    expect(document.querySelector('[data-approval-queue="recent"]')).not.toBeNull();
  });

  it('a sent message says "Sent" once: its delivery status stands in for the dispatch chip', () => {
    const decided = (id: string, state: 'SENT' | 'FAILED', status: 'SENT' | 'FAILED') =>
      message(id, 'reply-guard', {
        status: 'APPROVED',
        decidedAt: new Date('2026-10-19T10:00:00Z'),
        decidedByName: 'Ananya Sharma',
        message: { ...message(id, 'reply-guard').message!, channel: 'WHATSAPP', status, simulated: true },
        dispatch: { state, channel: 'WHATSAPP', reasonCode: null, reasonLabel: state === 'FAILED' ? 'Provider refused' : null, deferredUntil: null },
      });
    renderList([decided('sent', 'SENT', 'SENT'), decided('failed', 'FAILED', 'FAILED')], true);
    const sent = row('sent').querySelector('[data-dispatch-state="SENT"]') as HTMLElement;
    expect(sent).not.toBeNull();
    expect(sent.querySelector('[data-status-badge]')?.getAttribute('aria-label')).toBe('Sent, Simulated');
    expect(within(row('sent')).getAllByText('Sent')).toHaveLength(1);
    // Any other dispatch state keeps its own chip next to the message's delivery status.
    expect(row('failed').querySelector('[data-dispatch-state="FAILED"] [data-tone="danger"]')).not.toBeNull();
    expect(row('failed').querySelector('[data-status-badge]')).not.toBeNull();
  });

  it('the waiting chip rises in tone with the age and always says it in words', () => {
    renderList([
      message('fresh', null, { requestedAt: new Date('2026-10-19T11:30:00Z') }),
      message('late', null, { requestedAt: new Date('2026-10-19T06:00:00Z') }),
      message('overdue', null, { requestedAt: new Date('2026-10-17T12:00:00Z') }),
    ]);
    expect(within(row('fresh')).getByText('Waiting 30 min').closest('[data-tone]')?.getAttribute('data-tone')).toBe('neutral');
    expect(within(row('late')).getByText('Waiting 6 h').closest('[data-tone]')?.getAttribute('data-tone')).toBe('warning');
    expect(within(row('overdue')).getByText('Waiting 2 d').closest('[data-tone]')?.getAttribute('data-tone')).toBe('danger');
  });
});
