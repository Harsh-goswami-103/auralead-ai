/**
 * The closed status vocabulary (06-design §11.6, F2, F6). Every integration status and every
 * delivery display state has exactly one label, tone and icon here; StatusBadge renders them and
 * nothing else may invent a status label. Tones map to tokens; color is never the only signal.
 */
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleSlash,
  CircleX,
  Clock,
  Eye,
  FlaskConical,
  Loader,
  Send,
  ShieldAlert,
  TriangleAlert,
  Unplug,
  PencilLine,
  type LucideIcon,
} from 'lucide-react';
import type { IntegrationStatus, MessageStatus } from '@/lib/domain/enums';

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'demo';

export type StatusEntry = {
  label: string;
  tone: StatusTone;
  icon: LucideIcon;
  /** The icon spins (motion-safe only). */
  spinning?: boolean;
  /** One line shown under the badge when the caller asks for detail. */
  detail?: string;
};

export const INTEGRATION_STATUS_VOCABULARY: Readonly<Record<IntegrationStatus, StatusEntry>> = {
  NOT_CONFIGURED: { label: 'Not configured', tone: 'neutral', icon: CircleDashed, detail: 'Set it up to use this channel.' },
  CONFIGURED_UNVERIFIED: { label: 'Verification required', tone: 'warning', icon: ShieldAlert, detail: 'Saved, but not yet verified with the provider.' },
  VERIFYING: { label: 'Verifying', tone: 'neutral', icon: Loader, spinning: true },
  CONNECTED: { label: 'Connected', tone: 'success', icon: CircleCheck },
  DEGRADED: { label: 'Limited', tone: 'warning', icon: TriangleAlert, detail: 'Working with a restriction; see the cause on the card.' },
  ERROR: { label: 'Connection failed', tone: 'danger', icon: CircleX, detail: 'The last check failed. Retry the test after fixing the cause.' },
  REVOKED: { label: 'Revoked', tone: 'neutral', icon: Unplug, detail: 'Access was revoked. Reconnect to use it again.' },
  SIMULATED: { label: 'Demo simulation', tone: 'demo', icon: FlaskConical, detail: 'No provider is called in DEMO mode.' },
};

/** Delivery display states: the MessageStatus projection plus the ambiguous outcome (F6). */
export const DELIVERY_STATUS_VOCABULARY: Readonly<Record<MessageStatus, StatusEntry>> = {
  DRAFT: { label: 'Draft', tone: 'neutral', icon: PencilLine, detail: 'Not sent.' },
  PENDING: { label: 'Pending', tone: 'info', icon: Clock, detail: 'Queued for sending.' },
  SENT: { label: 'Sent', tone: 'info', icon: Send },
  DELIVERED: { label: 'Delivered', tone: 'success', icon: CircleCheck },
  READ: { label: 'Read', tone: 'success', icon: Eye },
  FAILED: { label: 'Failed', tone: 'danger', icon: CircleAlert },
  UNKNOWN: { label: 'Unknown (provider timeout)', tone: 'warning', icon: CircleHelp, detail: 'Not retried automatically to avoid a duplicate.' },
  NOT_SENT: { label: 'Not sent', tone: 'neutral', icon: CircleSlash, detail: 'Blocked before sending; no message left this app.' },
};

/** Token classes per tone: text color for icon and label, a quiet tinted surface. */
export const TONE_CLASSES: Readonly<Record<StatusTone, string>> = {
  neutral: 'text-fg-2 bg-bg-2 border-border-strong',
  success: 'text-success bg-success/10 border-success/30',
  warning: 'text-warning bg-warning/10 border-warning/30',
  danger: 'text-danger bg-danger/10 border-danger/30',
  info: 'text-info bg-info/10 border-info/30',
  demo: 'text-demo bg-demo/10 border-demo/30',
};
