/**
 * What each dashboard number means (T25; 06-design §11.1 "definitions in an info popover"; O6,
 * ADR-28). One definition string per widget, shown next to its number, plus the Prisma filters
 * that implement it. The client command center (one workspace, through the scoped client) and the
 * admin global metrics (every workspace of the mode, grouped by workspace) use the same filters, so
 * a workspace's row in the admin table always equals its owner's command center.
 *
 * O6: "Pipeline value" is the open offers (SENT and VIEWED, still valid); "Accepted quote value" is
 * what customers accepted; "Confirmed revenue" is shown as unavailable, because AuraLead records no
 * payments and an acceptance is not money received.
 */
import type { Prisma } from '@/generated/prisma/client';
import { daysBefore, RECENT_DAYS, type MetricDefinition } from './widget';

export const CLIENT_METRICS = {
  newLeads: {
    id: 'newLeads',
    label: 'New leads (7 days)',
    definition: 'Leads created in this workspace in the 7 days before the "As of" time, from every source. A duplicate merged into another lead is not counted.',
  },
  openConversations: {
    id: 'openConversations',
    label: 'Open conversations',
    definition: 'WhatsApp and email conversations that are not closed, including threads a person has taken over.',
  },
  quotesAwaitingApproval: {
    id: 'quotesAwaitingApproval',
    label: 'Quotes awaiting approval',
    definition: 'Quotations in Draft: their current version is not approved yet, so nothing can be sent. Drafts that need a pricing review first are included.',
  },
  pipelineValue: {
    id: 'pipelineValue',
    label: 'Pipeline value',
    definition:
      'Sum of the current-version totals (tax included) of quotations that are Sent or Opened and still inside their validity date. Drafts, approved quotes not yet sent, accepted, expired and cancelled quotations are not included.',
  },
  acceptedQuoteValue: {
    id: 'acceptedQuoteValue',
    label: 'Accepted quote value',
    definition: 'Sum of the totals (tax included) of the quotation versions customers accepted. An acceptance is not a payment: AuraLead records no payments, so this is not revenue.',
  },
  funnel: {
    id: 'funnel',
    label: 'Leads by sales stage',
    definition: 'Every lead of this workspace counted once, in its current sales stage. Merged duplicates are not counted. Lost is shown apart from the forward stages.',
  },
  activity: {
    id: 'activity',
    label: 'Recent activity',
    definition: "The latest entries of this workspace's audit trail: what changed, who or what changed it, and when.",
  },
  needsYou: {
    id: 'needsYou',
    label: 'Needs you',
    definition: 'Items waiting for a person in this workspace, each counted from the stored records described on its line.',
  },
} as const satisfies Record<string, MetricDefinition>;

/** O6: never derived from quotes. */
export const CONFIRMED_REVENUE = {
  id: 'confirmedRevenue',
  label: 'Confirmed revenue',
  value: 'Unavailable',
  reason: 'No payment data',
  definition: 'Unavailable: AuraLead does not record payments, so it cannot confirm revenue. Accepted quotes are counted under "Accepted quote value", which is not money received.',
} as const;

export type ConfirmedRevenue = { available: false; label: string; value: string; reason: string };

export function confirmedRevenue(): ConfirmedRevenue {
  return { available: false, label: CONFIRMED_REVENUE.label, value: CONFIRMED_REVENUE.value, reason: CONFIRMED_REVENUE.reason };
}

export type NeedsYouId =
  | 'quoteApprovals'
  | 'messageApprovals'
  | 'invalidatedApprovals'
  | 'failedDeliveries'
  | 'unknownDeliveries'
  | 'takeoverThreads'
  | 'openCallRequests'
  // ADR-124 (lead-gen F5): leads the operator handed over that the client has not acknowledged yet.
  | 'handedOverLeads';

export type NeedsYouDefinition = MetricDefinition & { id: NeedsYouId; href: string | null; tone: 'attention' | 'problem' | 'info' };

/** The "Needs you" lines in display order. `href` is the page where the item is handled. */
export const NEEDS_YOU_ITEMS: Readonly<Record<NeedsYouId, NeedsYouDefinition>> = {
  quoteApprovals: {
    id: 'quoteApprovals',
    label: 'Quotations waiting for approval',
    definition: 'Quotation versions waiting for an approve or reject decision.',
    href: '/dashboard/user/quotations?status=DRAFT',
    tone: 'attention',
  },
  messageApprovals: {
    id: 'messageApprovals',
    label: 'Messages waiting for review',
    definition: 'Message drafts (suggested replies and saved drafts) waiting for someone to approve and send, or reject.',
    href: '/dashboard/user/inbox',
    tone: 'attention',
  },
  invalidatedApprovals: {
    id: 'invalidatedApprovals',
    label: 'Approvals withdrawn by an edit (7 days)',
    definition: 'Quote approvals withdrawn in the last 7 days because the quotation was edited after it was approved. The new version needs approval again.',
    href: '/dashboard/user/quotations?status=DRAFT',
    tone: 'attention',
  },
  failedDeliveries: {
    id: 'failedDeliveries',
    label: 'Failed sends (7 days)',
    definition: 'Outbound messages created in the last 7 days whose delivery status is Failed.',
    href: '/dashboard/user/inbox',
    tone: 'problem',
  },
  unknownDeliveries: {
    id: 'unknownDeliveries',
    label: 'Delivery unknown',
    definition: 'Outbound messages whose delivery is unknown after a provider timeout. They are never resent automatically; an operator resolves each one.',
    href: '/dashboard/user/inbox',
    tone: 'problem',
  },
  takeoverThreads: {
    id: 'takeoverThreads',
    label: 'Threads a person is handling',
    definition: 'Open conversations where a person took over, so automated replies are paused until someone resumes them.',
    href: '/dashboard/user/inbox',
    tone: 'info',
  },
  openCallRequests: {
    id: 'openCallRequests',
    label: 'Call requests',
    definition: 'Customers who asked for a call (the quick reply, or recorded by hand) whose request is still Open. The Inbox marks their thread "Call requested".',
    href: '/dashboard/user/inbox',
    tone: 'attention',
  },
  handedOverLeads: {
    id: 'handedOverLeads',
    label: 'Handed over to you',
    definition: 'Leads your AuraLead operator handed over to your team that nobody has acknowledged yet. Open one to read the note and the summary, then acknowledge it.',
    href: '/dashboard/user/leads?handedOver=1',
    tone: 'attention',
  },
};

export const NEEDS_YOU_ORDER: readonly NeedsYouId[] = [
  'handedOverLeads',
  'quoteApprovals',
  'messageApprovals',
  'invalidatedApprovals',
  'failedDeliveries',
  'unknownDeliveries',
  'takeoverThreads',
  'openCallRequests',
];

// ---- Filters (shared by the client and admin loaders) ---------------------------------------------

/** Leads that count anywhere: a duplicate merged into another lead is not a lead of its own. */
export const LIVE_LEAD_WHERE = { mergedIntoLeadId: null } as const satisfies Prisma.LeadWhereInput;

export function newLeadsWhere(now: Date): Prisma.LeadWhereInput {
  return { ...LIVE_LEAD_WHERE, createdAt: { gte: daysBefore(now, RECENT_DAYS) } };
}

export const OPEN_CONVERSATION_WHERE = { closedAt: null } as const satisfies Prisma.ConversationWhereInput;

export const AWAITING_APPROVAL_WHERE = { status: 'DRAFT' } as const satisfies Prisma.QuoteWhereInput;

export const PIPELINE_STATUSES = ['SENT', 'VIEWED'] as const;

/** The current version of a SENT or VIEWED quote that is still inside its validity (not effectively EXPIRED). */
export function pipelineVersionWhere(now: Date): Prisma.QuoteVersionWhereInput {
  return { currentOf: { some: { status: { in: [...PIPELINE_STATUSES] }, validUntil: { gt: now } } } };
}

/** The accepted version of an ACCEPTED quote. */
export const ACCEPTED_VERSION_WHERE = { acceptedOf: { some: { status: 'ACCEPTED' } } } as const satisfies Prisma.QuoteVersionWhereInput;

export function needsYouApprovalsWhere(now: Date): Prisma.ApprovalWhereInput {
  return {
    OR: [
      { status: 'PENDING', kind: { in: ['QUOTE_VERSION', 'OUTBOUND_MESSAGE'] } },
      { status: 'INVALIDATED', kind: 'QUOTE_VERSION', invalidationReason: 'QUOTE_REVISED', decidedAt: { not: null }, invalidatedAt: { gte: daysBefore(now, RECENT_DAYS) } },
    ],
  };
}

export function needsYouMessagesWhere(now: Date): Prisma.MessageWhereInput {
  return {
    direction: 'OUT',
    OR: [{ status: 'FAILED', createdAt: { gte: daysBefore(now, RECENT_DAYS) } }, { status: 'UNKNOWN' }],
  };
}

export const OPEN_CALL_REQUEST_WHERE = { status: 'OPEN' } as const satisfies Prisma.CallRequestWhereInput;

/** ADR-124: handoffs the client has not acknowledged yet (one per lead). */
export const OPEN_HANDOFF_WHERE = { status: 'HANDED_OVER' } as const satisfies Prisma.LeadHandoffWhereInput;

export const SALES_STAGES = ['NEW', 'CONTACTED', 'REPLIED', 'QUOTE_SENT', 'CONVERTED', 'LOST'] as const;
export type SalesStageKey = (typeof SALES_STAGES)[number];
