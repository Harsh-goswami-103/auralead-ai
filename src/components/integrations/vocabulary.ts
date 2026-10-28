/**
 * Words, icons and gates of the Integration center and the source pages (T28). Statuses are always
 * icon plus label (06-design F2); raw provider strings (template status and category, campaign
 * status, quality) are shown verbatim with a tone derived for the icon only (plan §5.1: never
 * enums). Gates follow plan §12: configuration, permission or mode only, each with a fix link
 * when there is one.
 */
import {
  Bot,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleSlash,
  Clock,
  FileSpreadsheet,
  Inbox,
  Mail,
  MapPinned,
  Megaphone,
  MessageCircle,
  PauseCircle,
  Server,
  Unplug,
  type LucideIcon,
} from 'lucide-react';
import type { Gate } from '@/components/patterns/GatedAction';
import type { StatusTone } from '@/components/patterns/status-vocabulary';
import type { IntegrationKind, IntegrationStatus } from '@/lib/domain/enums';

export const KIND_ICONS: Readonly<Record<IntegrationKind, LucideIcon>> = {
  WHATSAPP_CLOUD: MessageCircle,
  EMAIL_RESEND: Mail,
  EMAIL_SMTP: Server,
  META_ADS: Megaphone,
  GOOGLE_SHEETS: FileSpreadsheet,
  AI_ANTHROPIC: Bot,
  AI_OPENAI: Bot,
  GOOGLE_PLACES: MapPinned,
};

export type RawStatusEntry = { label: string; tone: StatusTone; icon: LucideIcon };

/** A raw provider status (template, campaign) shown verbatim, with an icon tone for the common values. */
export function rawStatusEntry(raw: string | null): RawStatusEntry {
  if (raw === null || raw.trim() === '') return { label: 'Unknown', tone: 'neutral', icon: CircleHelp };
  const value = raw.trim().toUpperCase();
  const label = raw.trim();
  if (value === 'APPROVED' || value === 'ACTIVE' || value === 'GREEN') return { label, tone: 'success', icon: CircleCheck };
  if (value === 'REJECTED' || value === 'DISABLED' || value === 'DELETED' || value === 'RED') return { label, tone: 'danger', icon: CircleSlash };
  if (value === 'PAUSED' || value === 'CAMPAIGN_PAUSED' || value === 'ADSET_PAUSED') return { label, tone: 'warning', icon: PauseCircle };
  if (value === 'PENDING' || value === 'IN_APPEAL' || value === 'IN_PROCESS' || value === 'YELLOW') return { label, tone: 'warning', icon: Clock };
  return { label, tone: 'neutral', icon: CircleDashed };
}

/** Webhook delivery states of a lead source, in words. */
export const DELIVERY_STATE: Readonly<Record<string, RawStatusEntry>> = {
  RECEIVED: { label: 'Queued for the worker', tone: 'info', icon: Clock },
  PROCESSED: { label: 'Processed', tone: 'success', icon: CircleCheck },
  FAILED: { label: 'Failed', tone: 'danger', icon: CircleAlert },
  UNROUTED: { label: 'Not routed to a workspace', tone: 'warning', icon: Unplug },
  PENDING_CORRELATION: { label: 'Waiting to match', tone: 'info', icon: Clock },
  ORPHAN: { label: 'Unmatched', tone: 'neutral', icon: CircleHelp },
};

export const BATCH_STATE: Readonly<Record<string, RawStatusEntry>> = {
  RECEIVED: { label: 'Received', tone: 'info', icon: Inbox },
  PROCESSING: { label: 'Processing', tone: 'info', icon: Clock },
  COMPLETED: { label: 'Completed', tone: 'success', icon: CircleCheck },
  PARTIAL: { label: 'Partly failed', tone: 'warning', icon: CircleAlert },
  FAILED: { label: 'Failed', tone: 'danger', icon: CircleAlert },
};

/** Per-row outcomes that need a person (LeadSourceRecord status and reason code). */
export const ROW_STATUS_LABELS: Readonly<Record<string, string>> = { REJECTED: 'Rejected', REVIEW: 'Needs review', UNRETRIEVABLE: 'Could not be fetched' };

export const ROW_REASON_LABELS: Readonly<Record<string, string>> = {
  NO_VALID_CONTACT: 'No valid phone number or email',
  MISSING_NAME: 'Name missing',
  MULTIPLE_MATCHES: 'Matches more than one existing lead',
  CONTACT_MATCH: 'Matches an existing lead',
  ALREADY_RECEIVED: 'Already received earlier',
  DUPLICATE_IN_BATCH: 'Repeated in the same delivery',
};

export function rowReason(code: string | null): string {
  if (code === null) return 'No reason recorded';
  return ROW_REASON_LABELS[code] ?? 'See the record in the lead console';
}

/** Lead fields a Sheets column or a Meta form question can fill (MAPPABLE_FIELDS), in words. */
export const LEAD_FIELD_LABELS: Readonly<Record<string, string>> = { name: 'Name', phone: 'Phone', email: 'Email', website: 'Website', address: 'Address', city: 'City', category: 'Category' };

export const INTENT_LABELS: Readonly<Record<string, string>> = {
  FIRST_TOUCH: 'First message',
  QUOTE_READY: 'Quotation ready',
  FOLLOW_UP: 'Follow-up',
  CALL_ACK: 'Call request reply',
};

export const ACTIVITY_LABELS: Readonly<Record<string, string>> = {
  'integration.test': 'Connection tested',
  'integration.simulated.create': 'Demo simulation set up',
  'integration.templates.sync': 'Templates synced',
  'integration.credentials.set': 'Credentials saved',
  'integration.credentials.revoke': 'Credentials revoked',
  'integration.credentials.unreadable': 'Credential unreadable, re-enter',
  'integration.quality.check': 'Quality and limit checked',
  'integration.quality.automation_paused': 'Automation paused: quality rating RED',
  'integration.quality.automation_resumed': 'Automation resumed: quality rating no longer RED',
  'sheets.apps_script.secret': 'Apps Script signing secret issued',
};

/** Statuses a LIVE connection test can run on (stored, configured, not revoked). */
const LIVE_TESTABLE: ReadonlySet<IntegrationStatus> = new Set(['CONFIGURED_UNVERIFIED', 'VERIFYING', 'CONNECTED', 'DEGRADED', 'ERROR']);
const LIVE_SYNCABLE: ReadonlySet<IntegrationStatus> = new Set(['CONNECTED', 'DEGRADED']);

export function manageGate(canManage: boolean): Gate | null {
  return canManage ? null : { category: 'permission', reason: 'Your assignment here does not include “Manage integrations”. A super admin can grant it.' };
}

/** "Test connection": DEMO always runs (simulated); LIVE needs a configured integration. */
export function testConnectionGate(input: { mode: 'demo' | 'live'; canManage: boolean; status: IntegrationStatus; label: string; setupHref: string }): Gate | null {
  const permission = manageGate(input.canManage);
  if (permission) return permission;
  if (input.mode === 'demo' || LIVE_TESTABLE.has(input.status)) return null;
  return {
    category: 'configuration',
    reason: input.status === 'REVOKED' ? `${input.label} access was revoked. Reconnect it before testing.` : `${input.label} is not configured yet, so there is nothing to test.`,
    fix: { href: input.setupHref, label: 'Open setup' },
  };
}

/** "Sync templates": DEMO plays WhatsApp Manager; LIVE needs a connected WhatsApp integration. */
export function templateSyncGate(input: { mode: 'demo' | 'live'; canManage: boolean; status: IntegrationStatus; setupHref: string }): Gate | null {
  const permission = manageGate(input.canManage);
  if (permission) return permission;
  if (input.mode === 'demo' || LIVE_SYNCABLE.has(input.status)) return null;
  return { category: 'configuration', reason: 'Syncing templates needs WhatsApp to be connected and verified first.', fix: { href: input.setupHref, label: 'Open WhatsApp setup' } };
}

/** A simulation gate from the server (mode or permission), as a GatedAction gate. */
export function simulationGateOf(gate: { allowed: true } | { allowed: false; category: 'mode' | 'permission'; reason: string }): Gate | null {
  return gate.allowed ? null : { category: gate.category, reason: gate.reason };
}

/** Money in an ad account's currency from integer minor units (P6: never converted). */
export function formatMinor(minor: string, currency: string): string {
  try {
    const format = new Intl.NumberFormat('en-IN', { style: 'currency', currency });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(Number(minor) / 10 ** digits);
  } catch {
    return `${minor} ${currency} (minor units)`;
  }
}
