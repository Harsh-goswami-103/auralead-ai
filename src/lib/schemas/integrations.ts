/**
 * Request bodies of the Integration center routes (T28, T32), shared by the routes, the buttons and
 * the credential form (one schema set, plan §2). `workspaceSlug` names one of the caller's own
 * workspaces and is resolved server-side exactly like a `[ws]` segment (ADR-58); without it the
 * session's active workspace applies. The integration kind is the `[kind]` URL segment (catalog
 * slug), never a body field.
 *
 * Field rules (T32): every non-secret config field and every credential field of the catalog
 * (`src/lib/domain/integrations.ts`) has one rule here. The browser runs them for an immediate
 * answer; the credential service runs them again and is the judge. A DEMO process stores
 * placeholders only (`demo_...`), so no real secret ever lands in a demo database. Error texts
 * never repeat the value.
 */
import { z } from 'zod';
import type { IntegrationKind } from '../domain/enums';
import { QUICK_REPLY_INTENT_VALUES, TEMPLATE_INTENT_VALUES, TEMPLATE_VARIABLE_SOURCES } from '../domain/whatsapp-templates';

const workspaceSlug = z.string().trim().min(1).max(100).optional();

/** POST /api/app/integrations/[kind]/test */
export const IntegrationTestBody = z.object({ workspaceSlug });
export type IntegrationTestBody = z.infer<typeof IntegrationTestBody>;

/** POST /api/app/integrations/[kind]/templates/sync */
export const TemplateSyncBody = z.object({ workspaceSlug });
export type TemplateSyncBody = z.infer<typeof TemplateSyncBody>;

// ---- Credentials (T32) -----------------------------------------------------------------------------

export const CREDENTIAL_VALUE_MAX = 8192;
export const CONFIG_VALUE_MAX = 300;

/**
 * POST /api/app/integrations/[kind]/credentials: set or replace (rotate by re-entering) the
 * credentials and the non-secret configuration. Omitted or empty credential fields keep their
 * saved value; config values replace the stored ones.
 */
export const IntegrationCredentialsBody = z.object({
  workspaceSlug,
  config: z.record(z.string().max(64), z.string().max(CONFIG_VALUE_MAX)).optional(),
  credentials: z.record(z.string().max(64), z.string().max(CREDENTIAL_VALUE_MAX)).optional(),
});
export type IntegrationCredentialsBody = z.infer<typeof IntegrationCredentialsBody>;

export const REVOKE_CONFIRMATION = 'REVOKE';

/** POST /api/app/integrations/[kind]/credentials/revoke: removes every saved credential of the integration. */
export const IntegrationRevokeBody = z.object({ workspaceSlug, confirm: z.literal(REVOKE_CONFIRMATION) });
export type IntegrationRevokeBody = z.infer<typeof IntegrationRevokeBody>;

/** POST /api/app/integrations/whatsapp/templates/[templateId]/mapping (P12). */
export const TemplateMappingBody = z.object({
  workspaceSlug,
  intent: z.enum(TEMPLATE_INTENT_VALUES).nullable(),
  variables: z.record(z.string().regex(/^\d{1,2}$/), z.enum(Object.keys(TEMPLATE_VARIABLE_SOURCES) as [keyof typeof TEMPLATE_VARIABLE_SOURCES, ...Array<keyof typeof TEMPLATE_VARIABLE_SOURCES>])).default({}),
  buttons: z.record(z.string().regex(/^\d{1,2}$/), z.enum(QUICK_REPLY_INTENT_VALUES)).default({}),
});
export type TemplateMappingBody = z.infer<typeof TemplateMappingBody>;

// ---- Field rules -----------------------------------------------------------------------------------

export type FieldRule = {
  /** Needed before the integration counts as configured. */
  required: boolean;
  /** One line shown under the field. */
  hint: string;
  /** Returns the problem in words, or null when the value is acceptable. */
  check: (value: string) => string | null;
  /** Credential fields only: shown as a multi-line text area (JSON keys). */
  multiline?: boolean;
};

const NO_SPACE_RE = /^\S+$/;
const DIGITS_RE = /^\d{5,32}$/;
const HOST_RE = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const EMAIL_RE = /^[^\s@]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const token = (min: number, max: number, what: string) => (v: string) => {
  if (v.length < min || v.length > max) return `${what} must be ${min} to ${max} characters.`;
  if (!NO_SPACE_RE.test(v)) return `${what} cannot contain spaces or line breaks.`;
  return null;
};
const digits = (what: string) => (v: string) => (DIGITS_RE.test(v) ? null : `${what} is a number of 5 to 32 digits.`);
const host = (what: string) => (v: string) => (HOST_RE.test(v) ? null : `${what} must be a domain name such as mail.example.com.`);

function serviceAccountJson(v: string): string | null {
  if (v.length > CREDENTIAL_VALUE_MAX) return 'The key file is too large.';
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    return 'Paste the whole service account key file (JSON).';
  }
  const o = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  if (o.type !== 'service_account') return 'The JSON is not a service account key (its "type" must be "service_account").';
  if (typeof o.client_email !== 'string' || !EMAIL_RE.test(o.client_email)) return 'The key file has no service account email.';
  if (typeof o.private_key !== 'string' || !o.private_key.includes('PRIVATE KEY')) return 'The key file has no private key.';
  return null;
}

/** Non-secret configuration rules per kind and field (keys of `Integration.config`). */
export const CONFIG_FIELD_RULES: Readonly<Record<IntegrationKind, Readonly<Record<string, FieldRule>>>> = {
  WHATSAPP_CLOUD: {
    phoneNumberId: { required: true, hint: 'WhatsApp Manager > Phone numbers: the phone number ID (not the phone number).', check: digits('The phone number ID') },
    wabaId: { required: true, hint: 'The WhatsApp Business Account ID that owns the number and its templates.', check: digits('The WhatsApp Business Account ID') },
    businessPortfolioId: { required: false, hint: 'Optional. Business Settings > Business info.', check: digits('The business portfolio ID') },
  },
  EMAIL_RESEND: {
    fromDomain: { required: true, hint: 'A domain verified in Resend.', check: host('The sending domain') },
  },
  EMAIL_SMTP: {
    host: { required: true, hint: 'The SMTP server name.', check: host('The SMTP host') },
    port: { required: true, hint: 'Usually 587 (STARTTLS) or 465 (TLS).', check: (v) => (/^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 65535 ? null : 'The port is a number from 1 to 65535.') },
    username: { required: true, hint: 'The SMTP account name.', check: (v) => (v.length >= 1 && v.length <= 254 && NO_SPACE_RE.test(v) ? null : 'The username is 1 to 254 characters without spaces.') },
    fromAddress: { required: true, hint: 'The address emails are sent from.', check: (v) => (EMAIL_RE.test(v) ? null : 'Enter an email address such as quotes@example.com.') },
  },
  META_ADS: {
    pageId: { required: true, hint: 'The Facebook Page that owns the Instant Forms.', check: digits('The Page ID') },
    adAccountId: { required: false, hint: 'Optional, for campaign metrics: the ad account ID (with or without act_).', check: (v) => (/^(?:act_)?\d{5,32}$/.test(v) ? null : 'The ad account ID is digits, optionally starting with act_.') },
  },
  GOOGLE_SHEETS: {
    sheetId: { required: true, hint: 'The long ID in the Sheet URL between /d/ and /edit.', check: (v) => (/^[A-Za-z0-9_-]{20,128}$/.test(v) ? null : 'The spreadsheet ID is 20 to 128 letters, digits, - or _.') },
  },
  AI_ANTHROPIC: {
    modelId: { required: false, hint: 'Optional. Leave empty for the default model.', check: (v) => (/^[A-Za-z0-9._:/-]{1,128}$/.test(v) ? null : 'The model ID is 1 to 128 letters, digits and . _ : / -.') },
  },
  AI_OPENAI: {
    modelId: { required: true, hint: 'The model ID to draft with, exactly as OpenAI lists it.', check: (v) => (/^[A-Za-z0-9._:/-]{1,128}$/.test(v) ? null : 'The model ID is 1 to 128 letters, digits and . _ : / -.') },
  },
};

/** Credential rules per kind and field (keys of `Integration.secrets`), for LIVE values. */
export const CREDENTIAL_FIELD_RULES: Readonly<Record<IntegrationKind, Readonly<Record<string, FieldRule>>>> = {
  WHATSAPP_CLOUD: {
    accessToken: { required: true, hint: 'A system user access token with whatsapp_business_messaging and whatsapp_business_management.', check: token(20, 2048, 'The access token') },
  },
  EMAIL_RESEND: {
    apiKey: { required: true, hint: 'A Resend API key with sending access.', check: token(8, 512, 'The API key') },
    webhookSecret: { required: false, hint: 'Optional until email webhooks are set up: the webhook signing secret.', check: token(8, 512, 'The signing secret') },
  },
  EMAIL_SMTP: {
    password: { required: true, hint: 'The SMTP account password.', check: (v) => (v.length >= 1 && v.length <= 512 && !CONTROL_RE.test(v) ? null : 'The password is 1 to 512 characters without line breaks.') },
  },
  META_ADS: {
    accessToken: { required: true, hint: 'A Page or system user token with leads_retrieval.', check: token(20, 2048, 'The access token') },
  },
  GOOGLE_SHEETS: {
    serviceAccountJson: { required: true, hint: 'The whole JSON key file of the service account the Sheet is shared with.', check: serviceAccountJson, multiline: true },
    appsScriptSecret: { required: false, hint: 'Optional until the Apps Script is installed: its signing secret (32 characters or more).', check: token(32, 256, 'The signing secret') },
  },
  AI_ANTHROPIC: {
    apiKey: { required: true, hint: 'An API key from the Anthropic Console.', check: token(20, 512, 'The API key') },
  },
  AI_OPENAI: {
    apiKey: { required: true, hint: 'An API key from the OpenAI dashboard.', check: token(20, 512, 'The API key') },
  },
};

/** DEMO stores placeholders only: a real credential never lands in a demo database. */
export const DEMO_CREDENTIAL_RE = /^demo_[A-Za-z0-9_.-]{4,120}$/;
export const DEMO_CREDENTIAL_HINT = 'DEMO stores placeholders only: enter a value starting with demo_ (for example demo_token_1234). Real credentials belong in a LIVE install.';

export function configRule(kind: IntegrationKind, field: string): FieldRule | null {
  return CONFIG_FIELD_RULES[kind][field] ?? null;
}

export function credentialRule(kind: IntegrationKind, field: string): FieldRule | null {
  return CREDENTIAL_FIELD_RULES[kind][field] ?? null;
}

/** The problem with a credential value in words, or null. DEMO accepts `demo_` placeholders only. */
export function checkCredentialValue(kind: IntegrationKind, field: string, value: string, mode: 'demo' | 'live'): string | null {
  const rule = credentialRule(kind, field);
  if (!rule) return 'This integration has no such credential.';
  if (mode === 'demo') return DEMO_CREDENTIAL_RE.test(value) ? null : DEMO_CREDENTIAL_HINT;
  return rule.check(value);
}

export function checkConfigValue(kind: IntegrationKind, field: string, value: string): string | null {
  const rule = configRule(kind, field);
  if (!rule) return 'This integration has no such setting.';
  return rule.check(value);
}
