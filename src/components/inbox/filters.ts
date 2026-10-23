/**
 * The inbox filter keys read from the page's `?filter=` query (both panels). A plain module, so
 * server pages can call it; an unknown value is the full list.
 */
export type InboxFilterKey = 'all' | 'needs_you' | 'handed_over';

export function inboxFilterOf(value: string | string[] | undefined): InboxFilterKey {
  return value === 'needs_you' || value === 'handed_over' ? value : 'all';
}

export const INBOX_EMPTY: Readonly<Record<InboxFilterKey, { title: string; description: string }>> = {
  all: { title: 'No conversations', description: 'A thread starts when a lead messages you on WhatsApp, or when an approved template or email is sent to a lead.' },
  needs_you: {
    title: 'Nothing needs you right now',
    description: 'Drafts to approve, failed or unknown deliveries, call requests, threads taken over and escalated automatic replies appear here.',
  },
  handed_over: { title: 'No handed-over leads', description: 'Leads handed over to the client appear here with their conversation.' },
};
