/**
 * Domain enums (plan §5.1) and capabilities (§5.2) as const tuples, so client code and Zod
 * schemas in src/lib can use them without importing Prisma. tests/unit/lib/domain-enums.test.ts
 * checks every enum here against prisma/schema.prisma when the schema defines it.
 */
const e = <const T extends readonly string[]>(...values: T): T => values;

export const AppMode = e('DEMO', 'LIVE');
export const GlobalRole = e('USER', 'EMPLOYEE', 'SUPER_ADMIN');
export const MembershipRole = e('OWNER', 'MEMBER');
export const UserStatus = e('INVITED', 'ACTIVE', 'DISABLED');
export const WorkspaceStatus = e('ACTIVE', 'SUSPENDED');
export const SalesStage = e('NEW', 'CONTACTED', 'REPLIED', 'QUOTE_SENT', 'CONVERTED', 'LOST');
export const LeadSource = e('GOOGLE_SHEETS', 'META_ADS', 'GMAPS_EXTENSION', 'WHATSAPP_INBOUND', 'EMAIL_INBOUND', 'MANUAL');
export const WebsiteStatus = e('UNKNOWN', 'PRESENT_UNVERIFIED', 'REACHABLE', 'UNREACHABLE', 'BLOCKED', 'VERIFIED_ABSENT');
export const SourceRecordStatus = e('ACCEPTED', 'DUPLICATE', 'REVIEW', 'REJECTED', 'UNRETRIEVABLE');
export const ImportBatchStatus = e('RECEIVED', 'PROCESSING', 'COMPLETED', 'PARTIAL', 'FAILED');
export const MergeReviewStatus = e('OPEN', 'MERGED', 'KEPT_SEPARATE', 'DISMISSED');
export const ContactKeyKind = e('PHONE', 'EMAIL', 'PROVIDER');
export const Channel = e('WHATSAPP', 'EMAIL');
export const ConsentPurpose = e('MARKETING', 'SERVICE_CONVERSATION');
export const ConsentBasis = e('OPT_IN', 'INBOUND_MESSAGE', 'B2B_ATTESTED');
export const ConsentSource = e('SHEETS_FORM', 'META_FORM', 'INBOUND_MESSAGE', 'START_KEYWORD', 'MANUAL_EVIDENCE', 'EMPLOYEE_ATTESTATION');
export const SuppressionReason = e('STOP_BUTTON', 'STOP_KEYWORD', 'UNSUBSCRIBE', 'HARD_BOUNCE', 'COMPLAINT', 'MARKETING_STOPPED', 'MANUAL');
export const QuoteStatus = e('DRAFT', 'APPROVED', 'SENT', 'VIEWED', 'ACCEPTED', 'EXPIRED', 'CANCELLED');
export const DiscountKind = e('NONE', 'PERCENT_BPS', 'FLAT_PAISE');
export const ApprovalKind = e('QUOTE_VERSION', 'OUTBOUND_MESSAGE', 'PRICING_REVIEW');
export const ApprovalStatus = e('PENDING', 'APPROVED', 'REJECTED', 'INVALIDATED');
export const ConversationAiMode = e('OFF', 'DRAFT', 'AUTO');
export const MessageDirection = e('IN', 'OUT');
export const MessageStatus = e('DRAFT', 'PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'UNKNOWN', 'NOT_SENT');
export const DispatchState = e('QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED', 'AMBIGUOUS', 'CANCELLED');
export const DispatchFailureClass = e('PRE_SEND', 'RETRYABLE', 'PERMANENT');
export const SendIntent = e('MANUAL_SINGLE', 'BULK', 'AUTOMATED', 'CUSTOMER_REQUESTED_REPLY');
export const PipelineStage = e('INGESTION', 'SCORE', 'DRAFT', 'APPROVAL', 'DELIVERY');
export const StageRunStatus = e('PENDING', 'RUNNING', 'DONE', 'SKIPPED', 'FAILED');
export const JournalAction = e('STOP', 'CLEAR');
export const JobStatus = e('QUEUED', 'RUNNING', 'SUCCEEDED', 'DEAD', 'CANCELLED');
export const JobAttemptOutcome = e('SUCCEEDED', 'RETRYABLE', 'FATAL', 'AMBIGUOUS', 'LEASE_LOST', 'DEFERRED');
export const IntegrationKind = e('WHATSAPP_CLOUD', 'EMAIL_RESEND', 'EMAIL_SMTP', 'META_ADS', 'GOOGLE_SHEETS', 'AI_ANTHROPIC', 'AI_OPENAI');
export const IntegrationStatus = e(
  'NOT_CONFIGURED', 'CONFIGURED_UNVERIFIED', 'VERIFYING', 'CONNECTED', 'DEGRADED', 'ERROR', 'REVOKED', 'SIMULATED',
);
export const WebhookProvider = e('META_ADS', 'WHATSAPP', 'GOOGLE_SHEETS', 'GMAPS_EXTENSION', 'RESEND', 'DEMO');
export const WebhookStatus = e('RECEIVED', 'PROCESSED', 'FAILED', 'UNROUTED', 'PENDING_CORRELATION', 'ORPHAN');
export const CallRequestStatus = e('OPEN', 'CONTACTED', 'DONE', 'CANCELLED');
export const CallRequestSource = e('QUICK_REPLY', 'MANUAL');
export const CampaignActionState = e('PENDING', 'SENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'SIMULATED');
export const QuoteViewKind = e('FETCH', 'BEACON');
export const AuditResult = e('SUCCESS', 'DENIED', 'FAILED');
export const PipelineApprovalMode = e('HUMAN', 'POLICY_AUTO');

type Of<T extends readonly string[]> = T[number];
export type AppMode = Of<typeof AppMode>;
export type GlobalRole = Of<typeof GlobalRole>;
export type MembershipRole = Of<typeof MembershipRole>;
export type UserStatus = Of<typeof UserStatus>;
export type WorkspaceStatus = Of<typeof WorkspaceStatus>;
export type SalesStage = Of<typeof SalesStage>;
export type LeadSource = Of<typeof LeadSource>;
export type WebsiteStatus = Of<typeof WebsiteStatus>;
export type SourceRecordStatus = Of<typeof SourceRecordStatus>;
export type ImportBatchStatus = Of<typeof ImportBatchStatus>;
export type MergeReviewStatus = Of<typeof MergeReviewStatus>;
export type ContactKeyKind = Of<typeof ContactKeyKind>;
export type Channel = Of<typeof Channel>;
export type ConsentPurpose = Of<typeof ConsentPurpose>;
export type ConsentBasis = Of<typeof ConsentBasis>;
export type ConsentSource = Of<typeof ConsentSource>;
export type SuppressionReason = Of<typeof SuppressionReason>;
export type QuoteStatus = Of<typeof QuoteStatus>;
export type DiscountKind = Of<typeof DiscountKind>;
export type ApprovalKind = Of<typeof ApprovalKind>;
export type ApprovalStatus = Of<typeof ApprovalStatus>;
export type ConversationAiMode = Of<typeof ConversationAiMode>;
export type MessageDirection = Of<typeof MessageDirection>;
export type MessageStatus = Of<typeof MessageStatus>;
export type DispatchState = Of<typeof DispatchState>;
export type DispatchFailureClass = Of<typeof DispatchFailureClass>;
export type SendIntent = Of<typeof SendIntent>;
export type PipelineStage = Of<typeof PipelineStage>;
export type StageRunStatus = Of<typeof StageRunStatus>;
export type JournalAction = Of<typeof JournalAction>;
export type JobStatus = Of<typeof JobStatus>;
export type JobAttemptOutcome = Of<typeof JobAttemptOutcome>;
export type IntegrationKind = Of<typeof IntegrationKind>;
export type IntegrationStatus = Of<typeof IntegrationStatus>;
export type WebhookProvider = Of<typeof WebhookProvider>;
export type WebhookStatus = Of<typeof WebhookStatus>;
export type CallRequestStatus = Of<typeof CallRequestStatus>;
export type CallRequestSource = Of<typeof CallRequestSource>;
export type CampaignActionState = Of<typeof CampaignActionState>;
export type QuoteViewKind = Of<typeof QuoteViewKind>;
export type AuditResult = Of<typeof AuditResult>;
export type PipelineApprovalMode = Of<typeof PipelineApprovalMode>;

/** Capabilities granted through EmployeeAssignment; a workspace OWNER holds all of them (§5.2). */
export const CAPABILITIES = e(
  'leads.read',
  'leads.write',
  'leads.export',
  'drafts.generate',
  'quotes.edit',
  'pricing.override',
  'approvals.decide',
  'dispatch.send',
  'automation.manage',
  'integrations.manage',
  'campaigns.control',
  'extension.manage',
  'sheets.manage',
  'scoring.manage',
  'pipeline.manage',
);
export type Capability = Of<typeof CAPABILITIES>;

const CAPABILITY_SET: ReadonlySet<string> = new Set(CAPABILITIES);

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && CAPABILITY_SET.has(value);
}
