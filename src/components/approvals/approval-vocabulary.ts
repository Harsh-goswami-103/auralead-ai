/**
 * Approval queue vocabulary (employee report: "DISPATCH_WORDS is duplicated ... these copies will
 * drift"): one label, tone and icon per approval status, dispatch state, queue item kind and flag
 * family, used by QueueList and the approval item page. Status is never color alone: every entry
 * renders as icon + label (ToneChip).
 */
import {
  AlarmClock,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleSlash,
  Clock,
  Clock3,
  FileText,
  Loader2,
  Mail,
  MessageCircle,
  PenLine,
  PhoneCall,
  Reply,
  Send,
  Tag,
  Target,
  TriangleAlert,
  UserRound,
  Workflow,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { VocabularyEntry } from '@/components/leads/lead-vocabulary';

export const APPROVAL_STATUS_VOCABULARY: Readonly<Record<string, VocabularyEntry>> = {
  PENDING: { label: 'Waiting for approval', tone: 'warning', icon: Clock },
  APPROVED: { label: 'Approved', tone: 'success', icon: CircleCheck },
  REJECTED: { label: 'Rejected', tone: 'danger', icon: XCircle },
  INVALIDATED: { label: 'Withdrawn (the quotation changed)', tone: 'neutral', icon: CircleSlash },
};

export function approvalStatusEntry(status: string): VocabularyEntry {
  return APPROVAL_STATUS_VOCABULARY[status] ?? { label: status, tone: 'neutral', icon: CircleHelp };
}

/** DispatchAttempt state. `long` adds what the queue row leaves out. */
export const DISPATCH_VOCABULARY: Readonly<Record<string, VocabularyEntry & { long?: string }>> = {
  QUEUED: { label: 'Queued', tone: 'info', icon: Clock3 },
  SENDING: { label: 'Sending', tone: 'info', icon: Loader2, spinning: true },
  SENT: { label: 'Sent', tone: 'success', icon: Send },
  FAILED: { label: 'Failed', tone: 'danger', icon: CircleAlert },
  SKIPPED: { label: 'Blocked before sending', tone: 'neutral', icon: CircleSlash },
  AMBIGUOUS: { label: 'Delivery unknown', tone: 'warning', icon: CircleHelp, long: 'Delivery unknown (not retried automatically)' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', icon: CircleSlash },
};

export function dispatchEntry(state: string): VocabularyEntry & { long?: string } {
  return DISPATCH_VOCABULARY[state] ?? { label: state, tone: 'neutral', icon: CircleHelp };
}

/** What a queue item is, with its category color (quote aura, email ice, WhatsApp flare: the shared palette). */
export type ItemKind = 'quote' | 'email' | 'whatsapp';

export const ITEM_KINDS: Readonly<Record<ItemKind, { label: string; icon: LucideIcon; bar: string; tile: string; chip: string; iconClass: string; titleChip: string }>> = {
  quote: {
    label: 'Quotation',
    icon: FileText,
    bar: 'bg-aura',
    tile: 'border-aura/30 bg-aura/12',
    chip: 'border-aura/35 bg-aura/10 text-fg-1',
    iconClass: 'text-aura',
    titleChip: 'bg-aura/14 text-aura ring-aura/25',
  },
  email: {
    label: 'Email',
    icon: Mail,
    bar: 'bg-ice/60',
    tile: 'border-ice/30 bg-ice/8',
    chip: 'border-ice/30 bg-ice/8 text-fg-1',
    iconClass: 'text-ice',
    titleChip: 'bg-ice/10 text-ice ring-ice/25',
  },
  whatsapp: {
    label: 'WhatsApp',
    icon: MessageCircle,
    bar: 'bg-chart-3-hi',
    tile: 'border-chart-3-hi/35 bg-chart-3/12',
    chip: 'border-chart-3-hi/35 bg-chart-3/12 text-fg-1',
    iconClass: 'text-chart-3-hi',
    titleChip: 'bg-chart-3/14 text-chart-3-hi ring-chart-3-hi/30',
  },
};

/**
 * A StatTile (tone 'panel') re-tinted to a queue kind, so the tiles counting quotations and
 * messages carry the same colors as the rows below them: quotation aura, messages ice to flare
 * (email and WhatsApp; `in oklab` for the ice-to-pink run). Overrides the panel hue locally only.
 */
export const KIND_TILE = {
  quote: '[--panel-hue:var(--aura)] [--panel-grad:linear-gradient(90deg,var(--aura),var(--azure))]',
  message: '[--panel-hue:var(--ice)] [--panel-grad:linear-gradient(90deg_in_oklab,var(--ice),var(--chart-3-hi))]',
} as const;

/** Flag chips: what needs care (warning), what the customer asked (info), the rest neutral. */
export function flagTone(flag: string): { tone: 'warning' | 'info' | 'neutral'; icon: LucideIcon } {
  if (flag === 'needs_pricing_review' || flag.startsWith('ai_') || flag.startsWith('auto_blocked:') || flag.startsWith('policy_auto_blocked:')) {
    if (flag !== 'ai_reply') return { tone: 'warning', icon: TriangleAlert };
  }
  if (flag === 'call_request') return { tone: 'info', icon: PhoneCall };
  if (flag === 'customer_requested' || flag === 'escalated') return { tone: 'info', icon: UserRound };
  if (flag === 'pipeline_first_touch') return { tone: 'neutral', icon: Workflow };
  if (flag === 'ai_reply') return { tone: 'neutral', icon: Reply };
  if (flag === 'composer') return { tone: 'neutral', icon: PenLine };
  if (flag.startsWith('intent:')) return { tone: 'neutral', icon: Target };
  return { tone: 'neutral', icon: Tag };
}

/**
 * How long an item has waited, as an urgency tier (always with the clock icon and the words):
 * a few hours is normal, over four hours needs attention, a day is overdue.
 */
export function waitingTier(ms: number): { tone: 'neutral' | 'warning' | 'danger'; icon: LucideIcon } {
  const hours = ms / 3_600_000;
  if (hours >= 24) return { tone: 'danger', icon: AlarmClock };
  if (hours >= 4) return { tone: 'warning', icon: Clock3 };
  return { tone: 'neutral', icon: Clock3 };
}
