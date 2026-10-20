/**
 * The integration catalog (T28; PRD "Integration center", plan §5.6, §13, ADR-16, ADR-17, ADR-25).
 * One entry per `IntegrationKind`: its URL slug, provider, group, the non-secret config fields and
 * the credential fields it needs, what DEMO uses instead of the provider, and the provider-side
 * steps that come before a connection. Shared by the Integration center read model, its pages and
 * the routes (one source of names). Framework-free, browser-safe.
 *
 * Field names are the keys of `Integration.config` (non-secret, plan §5.6) and of the
 * `Integration.secrets` / `secretLast4` maps (A33: AAD `workspaceId|integrationId|<field>`). T32's
 * encrypted credential writer uses exactly these credential keys; the AI selection already reads
 * `secrets.apiKey` (ADR-55).
 */
import type { IntegrationKind } from './enums';

export type IntegrationGroup = 'messaging' | 'sources' | 'ai';

export type IntegrationField = { key: string; label: string };

export type IntegrationCatalogEntry = {
  kind: IntegrationKind;
  /** URL segment: /dashboard/employee/[ws]/integrations/[kind], /api/app/integrations/[kind]/... */
  slug: string;
  label: string;
  provider: string;
  group: IntegrationGroup;
  /** One line: what the integration does in this product. */
  summary: string;
  configFields: readonly IntegrationField[];
  credentialFields: readonly IntegrationField[];
  /** What a DEMO process uses instead of this provider (it never contacts it). */
  demoNote: string;
  /** Provider-side prerequisites, in order (done in the provider's own console). */
  prerequisites: readonly string[];
  /** The path the provider calls in LIVE, only where this app has the verified receiver. */
  webhookPath: string | null;
  /** Known limits of the channel the setup page must disclose. */
  disclosures: readonly string[];
};

export const INTEGRATION_GROUP_LABELS: Readonly<Record<IntegrationGroup, string>> = {
  messaging: 'Messaging',
  sources: 'Lead sources',
  ai: 'AI drafting',
};

export const INTEGRATION_CATALOG: readonly IntegrationCatalogEntry[] = [
  {
    kind: 'WHATSAPP_CLOUD',
    slug: 'whatsapp',
    label: 'WhatsApp Cloud API',
    provider: 'Meta',
    group: 'messaging',
    summary: 'Approved template messages, in-window replies, quick replies and delivery statuses.',
    configFields: [
      { key: 'phoneNumberId', label: 'Phone number ID' },
      { key: 'wabaId', label: 'WhatsApp Business Account ID' },
      { key: 'businessPortfolioId', label: 'Business portfolio ID' },
    ],
    credentialFields: [{ key: 'accessToken', label: 'System user access token' }],
    demoNote: 'DEMO sends WhatsApp messages to the demo transport (recorded on this machine, labelled Simulated) and takes inbound messages from the inbox simulator. Meta is never contacted.',
    prerequisites: [
      'In Meta for Developers, create a WhatsApp Business app and add the business phone number.',
      'Create a system user token with the whatsapp_business_messaging and whatsapp_business_management permissions.',
      'Create and get approval for your message templates in WhatsApp Manager; they are synced here, never written here.',
      'Register the webhook URL below for the messages field, using the verify token configured on the server.',
    ],
    webhookPath: '/api/webhooks/whatsapp',
    disclosures: ['Quality rating and messaging limits are shown exactly as Meta reports them, or as Unknown with the time of the last check.'],
  },
  {
    kind: 'EMAIL_RESEND',
    slug: 'email-resend',
    label: 'Resend email',
    provider: 'Resend',
    group: 'messaging',
    summary: 'Quotation and follow-up email with a signed unsubscribe link on every message.',
    configFields: [{ key: 'fromDomain', label: 'Sending domain' }],
    credentialFields: [
      { key: 'apiKey', label: 'API key' },
      { key: 'webhookSecret', label: 'Webhook signing secret' },
    ],
    demoNote: 'DEMO sends email to the demo transport (recorded on this machine, labelled Simulated). Resend is never contacted.',
    prerequisites: ['Verify the sending domain in Resend (SPF and DKIM records).', 'Create an API key with sending access.'],
    webhookPath: null,
    disclosures: ['Email permission is separate from WhatsApp consent: an opt-in on one channel never covers the other.'],
  },
  {
    kind: 'EMAIL_SMTP',
    slug: 'email-smtp',
    label: 'SMTP email',
    provider: 'Your mail server',
    group: 'messaging',
    summary: 'Email through your own mail server when Resend is not used.',
    configFields: [
      { key: 'host', label: 'SMTP host' },
      { key: 'port', label: 'Port' },
      { key: 'username', label: 'Username' },
      { key: 'fromAddress', label: 'From address' },
    ],
    credentialFields: [{ key: 'password', label: 'Password' }],
    demoNote: 'DEMO sends email to the demo transport (recorded on this machine, labelled Simulated). No mail server is contacted.',
    prerequisites: ['Use an SMTP account that is allowed to send from your domain (SPF and DKIM aligned).'],
    webhookPath: null,
    disclosures: ['SMTP has no inbound replies and no bounce tracking: replies go to your mailbox, not to the inbox here.'],
  },
  {
    kind: 'META_ADS',
    slug: 'meta-ads',
    label: 'Meta Lead Ads',
    provider: 'Meta',
    group: 'sources',
    summary: 'Instant Form leads from your Facebook Page, plus campaign metrics and pause or resume.',
    configFields: [
      { key: 'pageId', label: 'Page ID' },
      { key: 'adAccountId', label: 'Ad account ID' },
    ],
    credentialFields: [{ key: 'accessToken', label: 'Page or system user access token' }],
    demoNote: 'DEMO creates Meta leads with the simulator on the Meta page, which sets this integration up as a demo simulation. Meta is never contacted.',
    prerequisites: [
      'Connect the Facebook Page that owns the Instant Forms.',
      'Grant leads_retrieval and pages_manage_metadata to the app (Meta App Review may be required).',
      'Give the app access to the forms in Leads Access Manager.',
    ],
    webhookPath: null,
    disclosures: ['Google-Form-linked ads are not Meta Instant Forms: their rows arrive through Google Sheets.'],
  },
  {
    kind: 'GOOGLE_SHEETS',
    slug: 'google-sheets',
    label: 'Google Sheets',
    provider: 'Google',
    group: 'sources',
    summary: 'Google Form responses pushed by an Apps Script, and a mapped preview and sync of the Sheet.',
    configFields: [{ key: 'sheetId', label: 'Spreadsheet ID' }],
    credentialFields: [
      { key: 'serviceAccountJson', label: 'Service account key (JSON)' },
      { key: 'appsScriptSecret', label: 'Apps Script signing secret' },
    ],
    demoNote: 'DEMO creates form rows with the simulator on the Sheets page, which sets this integration up as a demo simulation. Google is never contacted.',
    prerequisites: [
      'Create a Google Cloud service account and download its JSON key.',
      'Share the Sheet with the service account email. A Sheet URL alone grants no access.',
    ],
    webhookPath: null,
    disclosures: ['Rows are pushed only by the Apps Script you install, signed with this workspace’s secret.'],
  },
  {
    kind: 'AI_ANTHROPIC',
    slug: 'ai-anthropic',
    label: 'Anthropic',
    provider: 'Anthropic',
    group: 'ai',
    summary: 'Drafts template variables, follow-ups and quote proposals. Prices always come from your price list.',
    configFields: [{ key: 'modelId', label: 'Model ID' }],
    credentialFields: [{ key: 'apiKey', label: 'API key' }],
    demoNote: 'DEMO drafts with the local deterministic generator (labelled local-deterministic). Anthropic is never contacted.',
    prerequisites: ['Create an API key in the Anthropic Console.'],
    webhookPath: null,
    disclosures: ['If the provider fails in LIVE, the draft goes to review; nothing switches to the local generator silently.'],
  },
  {
    kind: 'AI_OPENAI',
    slug: 'ai-openai',
    label: 'OpenAI',
    provider: 'OpenAI',
    group: 'ai',
    summary: 'An alternative drafting provider behind the same validated interface.',
    configFields: [{ key: 'modelId', label: 'Model ID (required)' }],
    credentialFields: [{ key: 'apiKey', label: 'API key' }],
    demoNote: 'DEMO drafts with the local deterministic generator (labelled local-deterministic). OpenAI is never contacted.',
    prerequisites: ['Create an API key in the OpenAI dashboard and choose the model ID to use.'],
    webhookPath: null,
    disclosures: ['If the provider fails in LIVE, the draft goes to review; nothing switches to the local generator silently.'],
  },
];

const BY_KIND = new Map(INTEGRATION_CATALOG.map((e) => [e.kind, e]));
const BY_SLUG = new Map(INTEGRATION_CATALOG.map((e) => [e.slug, e]));

/** Every IntegrationKind has exactly one catalog entry (checked by tests/unit/integrations/catalog.test.ts). */
export function catalogEntry(kind: IntegrationKind): IntegrationCatalogEntry {
  const entry = BY_KIND.get(kind);
  if (!entry) throw new Error(`integration catalog has no entry for ${kind}`);
  return entry;
}

export function integrationKindFromSlug(slug: string): IntegrationKind | null {
  return BY_SLUG.get(slug)?.kind ?? null;
}

export function integrationSlug(kind: IntegrationKind): string {
  return catalogEntry(kind).slug;
}

/** Display order of the Integration center (the catalog's order). */
export const INTEGRATION_KIND_ORDER: readonly IntegrationKind[] = INTEGRATION_CATALOG.map((e) => e.kind);

/** The user-facing line for a DEMO connection test: nothing was contacted, nothing was verified. */
export const SIMULATED_TEST_LABEL = 'Simulated, no provider contacted';
