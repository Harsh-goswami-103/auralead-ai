/**
 * People, workspace and audit vocabulary for the platform admin pages (T29): one label, icon and
 * tone per role, account status, membership role, capability, audit result and drilldown state,
 * so status is never color alone and never a raw enum. Roles take the signature hue of the panel
 * those people use (client user = aura, employee = zest, super admin = flare, as on the admin
 * home); account and audit states use the status tones. Plain module: importable from server and
 * client components.
 */
import {
  Ban,
  Bot,
  CircleCheck,
  CircleX,
  Cpu,
  Crown,
  Globe,
  Mail,
  ShieldCheck,
  ShieldX,
  UserCog,
  UserRound,
  UsersRound,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import type { StatusEntry } from '@/components/patterns/status-vocabulary';
import type { AuditResult, Capability, GlobalRole, IntegrationKind, JobStatus, MembershipRole, QuoteStatus, SalesStage, UserStatus } from '@/lib/domain/enums';

export type RoleStyle = { label: string; short: string; icon: LucideIcon; chip: string; panel: string };

export const ROLE_STYLES: Readonly<Record<GlobalRole, RoleStyle>> = {
  USER: { label: 'Client user', short: 'Client', icon: UserRound, chip: 'border-aura/35 bg-aura/12 text-aura', panel: 'Client panel' },
  EMPLOYEE: { label: 'Employee', short: 'Employee', icon: UserCog, chip: 'border-zest/35 bg-zest/10 text-zest', panel: 'Operator panel' },
  SUPER_ADMIN: { label: 'Super admin', short: 'Admin', icon: ShieldCheck, chip: 'border-flare/35 bg-flare/12 text-flare', panel: 'Platform admin' },
};

export const USER_STATUS_VOCABULARY: Readonly<Record<UserStatus, StatusEntry>> = {
  ACTIVE: { label: 'Active', tone: 'success', icon: CircleCheck },
  INVITED: { label: 'Invited', tone: 'info', icon: Mail, detail: 'Has not chosen a password yet.' },
  DISABLED: { label: 'Disabled', tone: 'danger', icon: Ban, detail: 'Cannot sign in; every session was ended.' },
};

export const MEMBERSHIP_ROLE_LABELS: Readonly<Record<MembershipRole, { label: string; icon: LucideIcon }>> = {
  OWNER: { label: 'Owner', icon: Crown },
  MEMBER: { label: 'Member', icon: UsersRound },
};

/** Readable capability names and what each one allows (plan §5.2). */
export const CAPABILITY_LABELS: Readonly<Record<Capability, { label: string; hint: string }>> = {
  'leads.read': { label: 'Read leads', hint: 'Open the lead console and lead details.' },
  'leads.write': { label: 'Edit leads', hint: 'Change lead stages and details.' },
  'leads.export': { label: 'Export leads', hint: 'Download lead lists as CSV.' },
  'drafts.generate': { label: 'Generate drafts', hint: 'Ask AI for message and quote drafts.' },
  'quotes.edit': { label: 'Edit quotations', hint: 'Create and revise quotation versions.' },
  'pricing.override': { label: 'Override pricing', hint: 'Change prices and discounts beyond the defaults.' },
  'approvals.decide': { label: 'Decide approvals', hint: 'Approve or reject quotations and messages.' },
  'dispatch.send': { label: 'Send', hint: 'Send approved WhatsApp and email messages.' },
  'automation.manage': { label: 'Manage automation', hint: 'Pause or resume the workspace automation.' },
  'integrations.manage': { label: 'Manage integrations', hint: 'Connect and test WhatsApp, email, Meta and AI.' },
  'campaigns.control': { label: 'Control campaigns', hint: 'Pause and resume Meta campaigns.' },
  'extension.manage': { label: 'Manage extension', hint: 'Issue and revoke Maps extension keys.' },
  'sheets.manage': { label: 'Manage Sheets', hint: 'Set up and sync Google Sheets sources.' },
  'scoring.manage': { label: 'Manage scoring', hint: 'Change the lead score configuration.' },
  'pipeline.manage': { label: 'Manage pipeline', hint: 'Edit the automation pipeline.' },
  'finder.run': { label: 'Run lead finder', hint: 'Search Google Places for businesses (paid calls in LIVE).' },
  'leads.import': { label: 'Import leads', hint: 'Upload Excel or CSV lead lists.' },
  'consent.import': { label: 'Import consent', hint: 'Record WhatsApp opt-ins from an attested file column (owner only by default).' },
  'templates.manage': { label: 'Manage templates', hint: 'Write WhatsApp templates and submit them for approval.' },
  'leads.handoff': { label: 'Hand over leads', hint: 'Pass converted leads to the client to close the deal.' },
};

export const AUDIT_RESULT_VOCABULARY: Readonly<Record<AuditResult, StatusEntry>> = {
  SUCCESS: { label: 'Success', tone: 'success', icon: CircleCheck },
  DENIED: { label: 'Denied', tone: 'warning', icon: ShieldX },
  FAILED: { label: 'Failed', tone: 'danger', icon: CircleX },
};

/** Who wrote an audit row, when no user is named. */
export const ACTOR_KIND_LABELS: Readonly<Record<string, { label: string; icon: LucideIcon }>> = {
  USER: { label: 'Client user', icon: UserRound },
  EMPLOYEE: { label: 'Employee', icon: UserCog },
  SUPER_ADMIN: { label: 'Super admin', icon: ShieldCheck },
  SYSTEM: { label: 'System', icon: Cpu },
  WORKER: { label: 'Worker', icon: Bot },
  WEBHOOK: { label: 'Webhook', icon: Webhook },
  PUBLIC: { label: 'Public link', icon: Globe },
};

/** Readable names for the administrators' own actions (the code stays visible next to them). */
export const ADMIN_ACTION_LABELS: Readonly<Record<string, string>> = {
  'admin.elevate': 'Opened the audited view',
  'workspace.create': 'Created the workspace',
  'workspace.plan_label': 'Changed the plan label',
  'invite.create': 'Created an invite',
  'invite.revoke': 'Revoked an invite',
  'membership.set': 'Granted or changed a membership',
  'membership.remove': 'Removed a membership',
  'assignment.set': 'Changed an employee assignment',
  'user.role_change': 'Changed the role',
  'user.status_change': 'Changed the account status',
  'password.reset_issue': 'Created a password reset link',
  'password.reset': 'Password reset by the person',
  'invite.redeem': 'Accepted an invite',
};

export const SALES_STAGE_LABELS: Readonly<Record<SalesStage, string>> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  REPLIED: 'Replied',
  QUOTE_SENT: 'Quote sent',
  CONVERTED: 'Converted',
  LOST: 'Lost',
};

export const QUOTE_STATUS_LABELS: Readonly<Record<QuoteStatus, string>> = {
  DRAFT: 'Draft',
  APPROVED: 'Approved',
  SENT: 'Sent',
  VIEWED: 'Viewed',
  ACCEPTED: 'Accepted',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
};

export const JOB_STATUS_LABELS: Readonly<Record<JobStatus, string>> = {
  QUEUED: 'Queued',
  RUNNING: 'Running',
  SUCCEEDED: 'Succeeded',
  DEAD: 'Dead',
  CANCELLED: 'Cancelled',
};

export const INTEGRATION_KIND_LABELS: Readonly<Record<IntegrationKind, string>> = {
  WHATSAPP_CLOUD: 'WhatsApp Cloud API',
  EMAIL_RESEND: 'Email (Resend)',
  EMAIL_SMTP: 'Email (SMTP)',
  META_ADS: 'Meta Lead Ads',
  GOOGLE_SHEETS: 'Google Sheets',
  AI_ANTHROPIC: 'AI (Anthropic)',
  AI_OPENAI: 'AI (OpenAI)',
  GOOGLE_PLACES: 'Google Places',
};

export const formatBps = (bps: number) => `${(bps / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`;
