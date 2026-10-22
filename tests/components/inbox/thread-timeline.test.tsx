/**
 * Inbox thread timeline, draft provenance (truthful UI, plan §10; the shared generator vocabulary in
 * src/lib/schemas/lead-console.ts): a reply that waits for approval reads "AI suggestion" only when a
 * model provider wrote it. The local template, the reply guard and system texts say what they are,
 * exactly as the Approvals page's GeneratorChip calls the same message; a person's own draft and a
 * sent message carry no marker.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ThreadTimeline } from '@/components/inbox/ThreadTimeline';
import type { ThreadMessage } from '@/server/services/messaging/inbox';

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
    status: 'DRAFT',
    statusLabel: 'Draft',
    simulated: true,
    generatorLabel: 'local-deterministic',
    sendIntent: null,
    automated: false,
    at,
    approval: null,
    attempt: null,
    deferredUntil: null,
    note: null,
    ...over,
  };
}

function marker(id: string): HTMLElement | null {
  return document.querySelector(`[data-message="${id}"] [data-draft-marker]`);
}

describe('ThreadTimeline draft provenance', () => {
  it('calls a draft an AI suggestion only when a model provider wrote it', () => {
    render(
      <ThreadTimeline
        messages={[
          message('m_anthropic', { generatorLabel: 'anthropic' }),
          message('m_openai', { generatorLabel: 'openai' }),
          message('m_template', { generatorLabel: 'local-deterministic' }),
          message('m_guard', { generatorLabel: 'reply-guard' }),
          message('m_system', { generatorLabel: 'system' }),
        ]}
        events={[]}
        timeZone="Asia/Kolkata"
        draftActions={() => null}
      />,
    );
    expect(marker('m_anthropic')?.textContent).toBe('AI suggestion · not sent');
    expect(marker('m_anthropic')?.getAttribute('data-draft-marker')).toBe('ai');
    expect(marker('m_openai')?.textContent).toBe('AI suggestion · not sent');
    expect(marker('m_template')?.textContent).toBe('Local template · not sent');
    expect(marker('m_guard')?.textContent).toBe('Automatic reply · not sent');
    expect(marker('m_system')?.textContent).toBe('System text · not sent');
    expect(document.body.textContent?.match(/AI suggestion/g)).toHaveLength(2);
  });

  it('marks no person-written draft and no sent message', () => {
    render(
      <ThreadTimeline
        messages={[
          message('m_human', { generatorLabel: 'human' }),
          message('m_none', { generatorLabel: null }),
          message('m_sent', { generatorLabel: 'anthropic', status: 'SENT', statusLabel: 'Sent' }),
        ]}
        events={[]}
        timeZone="Asia/Kolkata"
        draftActions={() => null}
      />,
    );
    expect(document.querySelectorAll('[data-draft-marker]')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('AI suggestion');
  });
});
