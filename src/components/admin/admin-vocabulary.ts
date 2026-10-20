/**
 * Platform admin status vocabulary (06-design §11.6, design spec §0.2): every job, dispatch,
 * attempt and webhook state the admin pages show has one label, tone and icon here, so status is
 * never color alone and never a raw enum. Server labels are kept verbatim where the server makes
 * them (jobLabel: 'Retry waiting', 'Dead: delivery unknown', 'Running (cancel requested)'; the
 * 'Delivery unknown' label of an AMBIGUOUS attempt). Webhook labels match the operator panel's
 * lead console. Plain module: importable from server and client components.
 */
import {
  CalendarClock,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleSlash,
  Clock,
  FlaskConical,
  Hourglass,
  Inbox,
  Loader,
  Mail,
  OctagonX,
  RotateCw,
  Send,
  SkipForward,
  Unlink,
  Unplug,
  type LucideIcon,
} from 'lucide-react';
import type { DispatchState, JobAttemptOutcome, JobStatus, SendIntent, WebhookProvider, WebhookStatus } from '@/lib/domain/enums';
import type { StatusEntry, StatusTone } from '@/components/patterns/status-vocabulary';
import { SOURCE_STYLES, type SourceStyle } from '@/components/patterns/source-style';

/** The server's label for an AMBIGUOUS attempt (messaging/delivery-state DELIVERY_UNKNOWN_LABEL). */
export const DELIVERY_UNKNOWN = 'Delivery unknown';

/** Readable option labels for the job status filter (the option values stay the raw enum). */
export const JOB_STATUS_OPTION_LABELS: Readonly<Record<JobStatus, string>> = {
  QUEUED: 'Queued (due or waiting)',
  RUNNING: 'Running',
  SUCCEEDED: 'Succeeded',
  DEAD: 'Dead',
  CANCELLED: 'Cancelled',
};

/** One entry per job status, for legends and the queue bar (labels as in jobLabel). */
export const JOB_STATUS_VOCABULARY: Readonly<Record<JobStatus, StatusEntry>> = {
  QUEUED: { label: 'Queued', tone: 'neutral', icon: Clock },
  RUNNING: { label: 'Running', tone: 'info', icon: Loader },
  SUCCEEDED: { label: 'Succeeded', tone: 'success', icon: CircleCheck },
  DEAD: { label: 'Dead', tone: 'danger', icon: OctagonX },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', icon: CircleSlash },
};

/**
 * The chip for one job, from the server's label. 'Retry waiting' keeps its label; it is a warning
 * only after a real failed attempt (a job scheduled for later that never ran is calm info).
 */
export function jobStatusEntry(job: { status: JobStatus; label: string; attempts: number }): StatusEntry {
  switch (job.status) {
    case 'QUEUED':
      if (job.label === 'Retry waiting') {
        return job.attempts > 0
          ? { label: job.label, tone: 'warning', icon: RotateCw, detail: 'Failed before; the next try waits for its run time.' }
          : { label: job.label, tone: 'info', icon: CalendarClock, detail: 'Scheduled for a later run time.' };
      }
      return { label: job.label, tone: 'neutral', icon: Clock };
    case 'RUNNING':
      return job.label === 'Running' ? { label: job.label, tone: 'info', icon: Loader, spinning: true } : { label: job.label, tone: 'warning', icon: Loader, spinning: true };
    case 'SUCCEEDED':
      return { label: job.label, tone: 'success', icon: CircleCheck };
    case 'CANCELLED':
      return { label: job.label, tone: 'neutral', icon: CircleSlash };
    case 'DEAD':
      return job.label === 'Dead: delivery unknown' ? { label: job.label, tone: 'warning', icon: CircleHelp } : { label: job.label, tone: 'danger', icon: OctagonX };
  }
}

export const DISPATCH_STATE_VOCABULARY: Readonly<Record<DispatchState, StatusEntry>> = {
  QUEUED: { label: 'Queued', tone: 'neutral', icon: Clock },
  SENDING: { label: 'Sending', tone: 'info', icon: Loader, spinning: true },
  SENT: { label: 'Sent', tone: 'success', icon: Send },
  FAILED: { label: 'Failed', tone: 'danger', icon: CircleAlert },
  SKIPPED: { label: 'Skipped', tone: 'neutral', icon: SkipForward },
  AMBIGUOUS: { label: DELIVERY_UNKNOWN, tone: 'warning', icon: CircleHelp },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', icon: CircleSlash },
};

export const SEND_INTENT_LABELS: Readonly<Record<SendIntent, string>> = {
  MANUAL_SINGLE: 'Manual send',
  BULK: 'Bulk send',
  AUTOMATED: 'Automated send',
  CUSTOMER_REQUESTED_REPLY: 'Reply the customer asked for',
};

/** Job attempt outcomes; `null` is an attempt still in flight. */
export function attemptOutcomeEntry(outcome: JobAttemptOutcome | null): StatusEntry {
  switch (outcome) {
    case null:
      return { label: 'In flight', tone: 'info', icon: Loader, spinning: true };
    case 'SUCCEEDED':
      return { label: 'Succeeded', tone: 'success', icon: CircleCheck };
    case 'RETRYABLE':
      return { label: 'Retryable error', tone: 'warning', icon: RotateCw };
    case 'FATAL':
      return { label: 'Fatal error', tone: 'danger', icon: OctagonX };
    case 'AMBIGUOUS':
      return { label: DELIVERY_UNKNOWN, tone: 'warning', icon: CircleHelp };
    case 'LEASE_LOST':
      return { label: 'Lease lost', tone: 'warning', icon: Unplug };
    case 'DEFERRED':
      return { label: 'Deferred', tone: 'info', icon: Clock };
  }
}

/** Webhook delivery states, worded as in the operator panel's lead console. */
export const WEBHOOK_STATUS_VOCABULARY: Readonly<Record<WebhookStatus, StatusEntry>> = {
  RECEIVED: { label: 'Queued for processing', tone: 'info', icon: Inbox },
  PROCESSED: { label: 'Processed', tone: 'success', icon: CircleCheck },
  FAILED: { label: 'Failed', tone: 'danger', icon: CircleAlert },
  UNROUTED: { label: 'Unrouted', tone: 'warning', icon: CircleHelp },
  PENDING_CORRELATION: { label: 'Waiting for a match', tone: 'warning', icon: Hourglass },
  ORPHAN: { label: 'No match', tone: 'warning', icon: Unlink },
};

/**
 * Webhook providers in the shared source palette (patterns/source-style), so a provider has the
 * same color here as its lead source everywhere else. Resend reuses the email style and the DEMO
 * simulator the neutral one (orange stays reserved for the DEMO banner and Simulated chips).
 */
export const PROVIDER_STYLES: Readonly<Record<WebhookProvider, SourceStyle>> = {
  META_ADS: SOURCE_STYLES.META_ADS,
  WHATSAPP: SOURCE_STYLES.WHATSAPP_INBOUND,
  GOOGLE_SHEETS: SOURCE_STYLES.GOOGLE_SHEETS,
  GMAPS_EXTENSION: SOURCE_STYLES.GMAPS_EXTENSION,
  RESEND: { ...SOURCE_STYLES.EMAIL_INBOUND, label: 'Resend (email)', icon: Mail },
  DEMO: { ...SOURCE_STYLES.MANUAL, label: 'Demo simulator', icon: FlaskConical },
};

export function providerStyle(provider: string): SourceStyle {
  return Object.hasOwn(PROVIDER_STYLES, provider) ? PROVIDER_STYLES[provider as WebhookProvider] : { ...SOURCE_STYLES.MANUAL, label: provider };
}

/** Classes for a status segment fill (bars and rails); status hues only, never decorative. */
export const TONE_FILL: Readonly<Record<StatusTone, string>> = {
  neutral: 'bg-chart-other',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  demo: 'bg-demo',
};

/** Classes for a status icon on its own (timeline nodes): tone icon on a 14% tone disc. */
export const TONE_NODE: Readonly<Record<StatusTone, string>> = {
  neutral: 'bg-bg-3 text-fg-2 ring-border-strong',
  success: 'bg-success/14 text-success ring-success/35',
  warning: 'bg-warning/14 text-warning ring-warning/35',
  danger: 'bg-danger/14 text-danger ring-danger/35',
  info: 'bg-info/14 text-info ring-info/35',
  demo: 'bg-demo/14 text-demo ring-demo/35',
};

export type { LucideIcon };

/** No-break space: a number never wraps away from its unit ("6 s" stays on one line). */
const NBSP = '\u00a0';

/** "3 s", "4 min", "1.5 h", "2 d": a compact age for heartbeats and queue lag. */
export function formatAge(ms: number): string {
  const abs = Math.max(0, ms);
  if (abs < 60_000) return `${Math.round(abs / 1000)}${NBSP}s`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}${NBSP}min`;
  if (abs < 172_800_000) return `${(abs / 3_600_000).toFixed(1)}${NBSP}h`;
  return `${Math.round(abs / 86_400_000)}${NBSP}d`;
}
