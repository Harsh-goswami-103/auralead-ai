/**
 * Template studio rules (ADR-123, slice F4). Framework-free and browser-safe: the studio form shows
 * the same errors and warnings the server enforces, and the service builds the stored components
 * and mapping from the same functions.
 *
 * A draft is what a person edits: the category they chose first (MARKETING or UTILITY), the
 * language, the name, a header (none, text, or a PDF document from the media library), the body
 * with positional `{{1}}..{{n}}` variables, each variable's source (filled per lead at send time,
 * `resolveLeadTemplateVariables`) and example value, an optional footer and buttons.
 *
 * Meta's template rules checked here (developers.facebook.com "Message templates" and "Supported
 * languages", as known to the implementer on 2026-10-23; UNVERIFIED until a live check, see
 * docs/integrations.md):
 *  - name: lowercase letters, digits and underscores, at most 512 characters;
 *  - language: one of Meta's template language codes;
 *  - header TEXT: at most 60 characters and at most one variable (`{{1}}`); DOCUMENT: a PDF;
 *  - body: required, at most 1024 characters, variables numbered `{{1}}..{{n}}` in order without
 *    gaps, never at the very start or end of the body, positional only (no named parameters);
 *  - footer: at most 60 characters, no variables;
 *  - buttons: at most 3 quick replies, 2 URL buttons and 1 phone button, text at most 25
 *    characters; quick replies are grouped before the call-to-action buttons (Meta's grouping rule);
 *    URL buttons are static https links (this app never fills a URL variable);
 *  - every variable needs an example value before submission.
 * Studio rules (ADR-123): UTILITY needs a "sent when" trigger and warns about promotional words;
 * MARKETING carries a Stop quick reply by default (mapped to the STOP payload, ADR-62) and warns
 * when it is removed. A header variable is accepted by Meta but cannot be filled by this app, so it
 * is a warning (the template would be "not sendable from here", `templateShape`).
 */
import { isTemplateVariableSource, TEMPLATE_VARIABLE_MAX_LENGTH, type QuickReplyIntentValue, type TemplateVariableSource } from './whatsapp-templates';

export const TEMPLATE_RULES_CHECKED_ON = '2026-10-23';

/** The categories a person may author (AUTHENTICATION templates are out of scope). */
export const STUDIO_CATEGORIES = ['MARKETING', 'UTILITY'] as const;
export type StudioCategory = (typeof STUDIO_CATEGORIES)[number];

export const STUDIO_CATEGORY_LABELS: Readonly<Record<StudioCategory, { label: string; hint: string }>> = {
  MARKETING: { label: 'Marketing', hint: 'Introductions, offers, brochures and follow-ups. Needs the customer’s marketing opt-in; carries a Stop button.' },
  UTILITY: { label: 'Utility', hint: 'A reply to something the customer started: a request, a booked meeting, an issued quotation. No promotion.' },
};

/** When a UTILITY template is sent (ADR-123): it must answer something the customer started. */
export const UTILITY_TRIGGERS = ['CUSTOMER_ASKED', 'MEETING_BOOKED', 'QUOTE_ISSUED'] as const;
export type UtilityTrigger = (typeof UTILITY_TRIGGERS)[number];

export const UTILITY_TRIGGER_LABELS: Readonly<Record<UtilityTrigger, string>> = {
  CUSTOMER_ASKED: 'The customer asked for it in the chat',
  MEETING_BOOKED: 'A meeting was booked',
  QUOTE_ISSUED: 'A quotation was issued',
};

export const HEADER_FORMATS = ['NONE', 'TEXT', 'DOCUMENT'] as const;
export type HeaderFormat = (typeof HEADER_FORMATS)[number];

export const TEMPLATE_LIMITS = {
  name: 512,
  headerText: 60,
  body: 1024,
  footer: 60,
  buttonText: 25,
  url: 2000,
  phone: 20,
  quickReplies: 3,
  urlButtons: 2,
  phoneButtons: 1,
  example: TEMPLATE_VARIABLE_MAX_LENGTH,
  /** Body variables the studio offers (Meta allows more; ten keeps the form and the AI copy sane). */
  variables: 10,
} as const;

/** Meta's template language codes (UNVERIFIED list, TEMPLATE_RULES_CHECKED_ON). */
export const TEMPLATE_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'en_US', label: 'English (US)' },
  { code: 'en_GB', label: 'English (UK)' },
  { code: 'hi', label: 'Hindi' },
  { code: 'bn', label: 'Bengali' },
  { code: 'gu', label: 'Gujarati' },
  { code: 'kn', label: 'Kannada' },
  { code: 'ml', label: 'Malayalam' },
  { code: 'mr', label: 'Marathi' },
  { code: 'pa', label: 'Punjabi' },
  { code: 'ta', label: 'Tamil' },
  { code: 'te', label: 'Telugu' },
  { code: 'ur', label: 'Urdu' },
  { code: 'af', label: 'Afrikaans' },
  { code: 'sq', label: 'Albanian' },
  { code: 'ar', label: 'Arabic' },
  { code: 'az', label: 'Azerbaijani' },
  { code: 'bg', label: 'Bulgarian' },
  { code: 'ca', label: 'Catalan' },
  { code: 'zh_CN', label: 'Chinese (China)' },
  { code: 'zh_HK', label: 'Chinese (Hong Kong)' },
  { code: 'zh_TW', label: 'Chinese (Taiwan)' },
  { code: 'hr', label: 'Croatian' },
  { code: 'cs', label: 'Czech' },
  { code: 'da', label: 'Danish' },
  { code: 'nl', label: 'Dutch' },
  { code: 'et', label: 'Estonian' },
  { code: 'fil', label: 'Filipino' },
  { code: 'fi', label: 'Finnish' },
  { code: 'fr', label: 'French' },
  { code: 'ka', label: 'Georgian' },
  { code: 'de', label: 'German' },
  { code: 'el', label: 'Greek' },
  { code: 'ha', label: 'Hausa' },
  { code: 'he', label: 'Hebrew' },
  { code: 'hu', label: 'Hungarian' },
  { code: 'id', label: 'Indonesian' },
  { code: 'ga', label: 'Irish' },
  { code: 'it', label: 'Italian' },
  { code: 'ja', label: 'Japanese' },
  { code: 'kk', label: 'Kazakh' },
  { code: 'rw_RW', label: 'Kinyarwanda' },
  { code: 'ko', label: 'Korean' },
  { code: 'ky_KG', label: 'Kyrgyz' },
  { code: 'lo', label: 'Lao' },
  { code: 'lv', label: 'Latvian' },
  { code: 'lt', label: 'Lithuanian' },
  { code: 'mk', label: 'Macedonian' },
  { code: 'ms', label: 'Malay' },
  { code: 'nb', label: 'Norwegian' },
  { code: 'fa', label: 'Persian' },
  { code: 'pl', label: 'Polish' },
  { code: 'pt_BR', label: 'Portuguese (Brazil)' },
  { code: 'pt_PT', label: 'Portuguese (Portugal)' },
  { code: 'ro', label: 'Romanian' },
  { code: 'ru', label: 'Russian' },
  { code: 'sr', label: 'Serbian' },
  { code: 'sk', label: 'Slovak' },
  { code: 'sl', label: 'Slovenian' },
  { code: 'es', label: 'Spanish' },
  { code: 'es_AR', label: 'Spanish (Argentina)' },
  { code: 'es_ES', label: 'Spanish (Spain)' },
  { code: 'es_MX', label: 'Spanish (Mexico)' },
  { code: 'sw', label: 'Swahili' },
  { code: 'sv', label: 'Swedish' },
  { code: 'th', label: 'Thai' },
  { code: 'tr', label: 'Turkish' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'uz', label: 'Uzbek' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'zu', label: 'Zulu' },
];

const LANGUAGE_CODES = new Set(TEMPLATE_LANGUAGES.map((l) => l.code));

export function isTemplateLanguage(code: string): boolean {
  return LANGUAGE_CODES.has(code);
}

/** Text of the default Stop quick reply on MARKETING templates (a STOP keyword itself, ADR-06). */
export const STOP_BUTTON_TEXT = 'Stop';

/** Words that make a UTILITY template read as promotion (ADR-123); Meta recategorizes or rejects those. */
export const PROMOTIONAL_WORDS = ['offer', 'discount', 'free', '% off', 'brochure', 'launch'] as const;

export const NAME_RE = /^[a-z0-9_]+$/;
const POSITIONAL_RE = /\{\{\s*(\d+)\s*\}\}/g;
const ANY_VARIABLE_RE = /\{\{[^}]*\}\}/;
const NAMED_RE = /\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/;
const HTTPS_URL_RE = /^https:\/\/[^\s/$.?#][^\s]*$/i;
const E164_RE = /^\+[1-9]\d{7,14}$/;

export type QuickReplyButton = { type: 'QUICK_REPLY'; text: string; intent: QuickReplyIntentValue | null };
export type UrlButton = { type: 'URL'; text: string; url: string };
export type PhoneButton = { type: 'PHONE_NUMBER'; text: string; phoneNumber: string };
export type DraftButton = QuickReplyButton | UrlButton | PhoneButton;

export type DraftHeader = { format: 'NONE' } | { format: 'TEXT'; text: string; example: string | null } | { format: 'DOCUMENT'; mediaId: string | null };

export type DraftVariable = { position: string; source: TemplateVariableSource; example: string };

/** Everything a person edits in the studio form. */
export type TemplateDraft = {
  category: StudioCategory;
  language: string;
  name: string;
  utilityTrigger: UtilityTrigger | null;
  header: DraftHeader;
  body: string;
  variables: DraftVariable[];
  footer: string | null;
  buttons: DraftButton[];
};

export type DraftIssue = { field: string; code: string; message: string };
export type DraftCheck = { ok: boolean; errors: DraftIssue[]; warnings: DraftIssue[] };

/** Positional variables in a text, numerically ordered and de-duplicated: ['1', '2']. */
export function positionalVariables(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(POSITIONAL_RE)) found.add(String(Number(m[1])));
  return [...found].sort((a, b) => Number(a) - Number(b));
}

/** A name suggestion from free text: lowercase, words joined by underscores, a-z0-9_ only. */
export function suggestTemplateName(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

/** The promotional words found in a text (lowercase, in list order). */
export function promotionalWordsIn(text: string): string[] {
  const lower = text.toLowerCase();
  const patterns: Readonly<Record<(typeof PROMOTIONAL_WORDS)[number], RegExp>> = {
    offer: /\boffers?\b/,
    discount: /\bdiscount(?:s|ed)?\b/,
    // "feel free to" is not an offer (the output policy's exception).
    free: /(?<!feel\s)\bfree\b(?!\s+to\b)/,
    '% off': /%\s*off\b/,
    brochure: /\bbrochures?\b/,
    launch: /\blaunch(?:es|ed|ing)?\b/,
  };
  return PROMOTIONAL_WORDS.filter((w) => patterns[w].test(lower));
}

/** A MARKETING template's default buttons: one Stop quick reply mapped to the STOP payload. */
export function defaultButtons(category: StudioCategory): DraftButton[] {
  return category === 'MARKETING' ? [{ type: 'QUICK_REPLY', text: STOP_BUTTON_TEXT, intent: 'STOP' }] : [];
}

export function hasStopButton(buttons: readonly DraftButton[]): boolean {
  return buttons.some((b) => b.type === 'QUICK_REPLY' && b.intent === 'STOP');
}

/** Quick replies first, then URL and phone buttons in their order (Meta's grouping rule); the stored button indexes follow this order. */
export function orderedButtons(buttons: readonly DraftButton[]): DraftButton[] {
  return [...buttons.filter((b) => b.type === 'QUICK_REPLY'), ...buttons.filter((b) => b.type !== 'QUICK_REPLY')];
}

/** The draft's variables for exactly the body's positions (unknown positions dropped, missing ones `manual` with no example). */
export function alignedVariables(draft: Pick<TemplateDraft, 'body' | 'variables'>): DraftVariable[] {
  const byPosition = new Map(draft.variables.map((v) => [String(Number(v.position)), v]));
  return positionalVariables(draft.body).map((position) => {
    const v = byPosition.get(position);
    return { position, source: v && isTemplateVariableSource(v.source) ? v.source : 'manual', example: (v?.example ?? '').trim() };
  });
}

function oneLine(value: string): boolean {
  return !/[\n\r\t]/.test(value) && !/ {4,}/.test(value);
}

/**
 * Checks a draft. Errors block saving (structure Meta would refuse) or, with `forSubmit`, the
 * submission (completeness: example values, a document for a document header). Warnings never
 * block: the person decides.
 */
export function checkTemplateDraft(draft: TemplateDraft, opts: { forSubmit: boolean }): DraftCheck {
  const errors: DraftIssue[] = [];
  const warnings: DraftIssue[] = [];
  const err = (field: string, code: string, message: string) => errors.push({ field, code, message });
  const warn = (field: string, code: string, message: string) => warnings.push({ field, code, message });

  // Name and language.
  const name = draft.name.trim();
  if (name === '') err('name', 'NAME_REQUIRED', 'Give the template a name.');
  else if (name.length > TEMPLATE_LIMITS.name) err('name', 'NAME_TOO_LONG', `The name can be at most ${TEMPLATE_LIMITS.name} characters.`);
  else if (!NAME_RE.test(name)) err('name', 'NAME_FORMAT', 'Use lowercase letters, digits and underscores only (for example website_intro).');
  if (!isTemplateLanguage(draft.language)) err('language', 'LANGUAGE_UNSUPPORTED', 'Choose one of the languages WhatsApp supports for templates.');

  // Category rules.
  if (draft.category === 'UTILITY' && draft.utilityTrigger === null) err('utilityTrigger', 'UTILITY_TRIGGER_REQUIRED', 'Say when this utility template is sent: it must answer something the customer started.');

  // Header.
  const header = draft.header;
  if (header.format === 'TEXT') {
    const text = header.text.trim();
    if (text === '') err('header', 'HEADER_TEXT_REQUIRED', 'Write the header text, or choose no header.');
    else if (text.length > TEMPLATE_LIMITS.headerText) err('header', 'HEADER_TEXT_TOO_LONG', `The header can be at most ${TEMPLATE_LIMITS.headerText} characters.`);
    if (NAMED_RE.test(text)) err('header', 'HEADER_NAMED_VARIABLE', 'Use {{1}} for a header variable; named variables are not supported.');
    const headerVars = positionalVariables(text);
    if (headerVars.length > 1 || (text.match(POSITIONAL_RE)?.length ?? 0) > 1) err('header', 'HEADER_TOO_MANY_VARIABLES', 'A header can have at most one variable.');
    else if (headerVars.length === 1) {
      if (headerVars[0] !== '1') err('header', 'HEADER_VARIABLE_NUMBER', 'The header variable must be {{1}}.');
      warn('header', 'HEADER_VARIABLE_NOT_SENDABLE', 'WhatsApp accepts one header variable, but this app does not fill it, so the template could not be sent from here.');
      if (opts.forSubmit && (header.example ?? '').trim() === '') err('header', 'HEADER_EXAMPLE_REQUIRED', 'Give an example value for the header variable.');
    }
  } else if (header.format === 'DOCUMENT') {
    if (opts.forSubmit && header.mediaId === null) err('header', 'HEADER_DOCUMENT_REQUIRED', 'Choose the PDF brochure for the document header.');
  }

  // Body.
  const body = draft.body;
  const trimmedBody = body.trim();
  if (trimmedBody === '') err('body', 'BODY_REQUIRED', 'Write the message body.');
  else if (body.length > TEMPLATE_LIMITS.body) err('body', 'BODY_TOO_LONG', `The body can be at most ${TEMPLATE_LIMITS.body} characters.`);
  if (NAMED_RE.test(body)) err('body', 'BODY_NAMED_VARIABLE', 'Use numbered variables such as {{1}}; named variables are not supported.');
  else if ([...body.matchAll(/\{\{[^}]*\}\}/g)].some((m) => !/^\{\{\s*\d+\s*\}\}$/.test(m[0]))) err('body', 'BODY_VARIABLE_FORMAT', 'A variable must be a number in double braces, such as {{1}}.');
  const positions = positionalVariables(body);
  if (positions.some((p, i) => Number(p) !== i + 1)) err('body', 'BODY_VARIABLES_NOT_SEQUENTIAL', 'Number the variables {{1}}, {{2}}, ... in order, without gaps.');
  if (positions.length > TEMPLATE_LIMITS.variables) err('body', 'BODY_TOO_MANY_VARIABLES', `Use at most ${TEMPLATE_LIMITS.variables} variables.`);
  if (trimmedBody !== '' && (/^\{\{\s*\d+\s*\}\}/.test(trimmedBody) || /\{\{\s*\d+\s*\}\}[.!?]?$/.test(trimmedBody))) {
    err('body', 'BODY_VARIABLE_AT_EDGE', 'WhatsApp does not accept a variable at the very start or end of the body; add words around it.');
  }
  for (const v of alignedVariables(draft)) {
    const example = v.example;
    if (example.length > TEMPLATE_LIMITS.example) err(`variables.${v.position}`, 'EXAMPLE_TOO_LONG', `The example for {{${v.position}}} can be at most ${TEMPLATE_LIMITS.example} characters.`);
    else if (example !== '' && !oneLine(example)) err(`variables.${v.position}`, 'EXAMPLE_FORMAT', `The example for {{${v.position}}} must be one line without tabs or long runs of spaces.`);
    else if (opts.forSubmit && example === '') err(`variables.${v.position}`, 'EXAMPLE_REQUIRED', `Give an example value for {{${v.position}}}: WhatsApp reviews the template with it.`);
  }

  // Footer.
  const footer = (draft.footer ?? '').trim();
  if (footer.length > TEMPLATE_LIMITS.footer) err('footer', 'FOOTER_TOO_LONG', `The footer can be at most ${TEMPLATE_LIMITS.footer} characters.`);
  if (ANY_VARIABLE_RE.test(footer)) err('footer', 'FOOTER_VARIABLE', 'A footer cannot contain variables.');

  // Buttons.
  const quick = draft.buttons.filter((b) => b.type === 'QUICK_REPLY');
  const urls = draft.buttons.filter((b) => b.type === 'URL');
  const phones = draft.buttons.filter((b) => b.type === 'PHONE_NUMBER');
  if (quick.length > TEMPLATE_LIMITS.quickReplies) err('buttons', 'TOO_MANY_QUICK_REPLIES', `Use at most ${TEMPLATE_LIMITS.quickReplies} quick replies.`);
  if (urls.length > TEMPLATE_LIMITS.urlButtons) err('buttons', 'TOO_MANY_URL_BUTTONS', `Use at most ${TEMPLATE_LIMITS.urlButtons} website buttons.`);
  if (phones.length > TEMPLATE_LIMITS.phoneButtons) err('buttons', 'TOO_MANY_PHONE_BUTTONS', `Use at most ${TEMPLATE_LIMITS.phoneButtons} call button.`);
  const texts = new Set<string>();
  draft.buttons.forEach((b, i) => {
    const field = `buttons.${i}`;
    const text = b.text.trim();
    if (text === '') err(field, 'BUTTON_TEXT_REQUIRED', 'Every button needs a text.');
    else if (text.length > TEMPLATE_LIMITS.buttonText) err(field, 'BUTTON_TEXT_TOO_LONG', `Button text can be at most ${TEMPLATE_LIMITS.buttonText} characters.`);
    else if (ANY_VARIABLE_RE.test(text)) err(field, 'BUTTON_TEXT_VARIABLE', 'Button text cannot contain variables.');
    const folded = text.toLowerCase();
    if (text !== '' && texts.has(folded)) err(field, 'BUTTON_TEXT_DUPLICATE', 'Two buttons cannot have the same text.');
    texts.add(folded);
    if (b.type === 'URL') {
      const url = b.url.trim();
      if (ANY_VARIABLE_RE.test(url)) err(field, 'URL_VARIABLE', 'Website buttons must be a fixed link: this app does not fill link variables.');
      else if (!HTTPS_URL_RE.test(url) || url.length > TEMPLATE_LIMITS.url) err(field, 'URL_INVALID', 'Enter a full https:// link.');
    } else if (b.type === 'PHONE_NUMBER') {
      if (!E164_RE.test(b.phoneNumber.trim()) || b.phoneNumber.trim().length > TEMPLATE_LIMITS.phone) err(field, 'PHONE_INVALID', 'Enter the number with its country code, for example +919876543210.');
    }
  });

  // Studio warnings.
  if (draft.category === 'MARKETING' && !hasStopButton(draft.buttons)) {
    warn('buttons', 'NO_STOP_BUTTON', 'Marketing templates should keep the Stop button, so a customer can opt out with one tap.');
  }
  if (draft.category === 'UTILITY') {
    const all = [header.format === 'TEXT' ? header.text : '', body, footer, ...draft.buttons.map((b) => b.text)].join('\n');
    const words = promotionalWordsIn(all);
    if (words.length > 0) warn('body', 'PROMOTIONAL_WORDS', `Utility templates must not promote: remove ${words.map((w) => `“${w}”`).join(', ')} or choose Marketing. WhatsApp may recategorize or reject it.`);
    if (header.format === 'DOCUMENT') warn('header', 'DOCUMENT_HEADER_UTILITY', 'A PDF brochure is promotion, so WhatsApp treats it as Marketing and may recategorize or reject a Utility template that carries one. Choose Marketing.');
  }
  return { ok: errors.length === 0, errors, warnings };
}

// ---- Stored shape ------------------------------------------------------------------------------

/** The provider components (Meta's create-template shape) a draft stands for, with examples. */
export function templateComponentsOf(draft: TemplateDraft, opts: { headerHandle?: string | null } = {}): Array<Record<string, unknown>> {
  const components: Array<Record<string, unknown>> = [];
  const header = draft.header;
  if (header.format === 'TEXT') {
    const text = header.text.trim();
    const example = (header.example ?? '').trim();
    components.push({ type: 'HEADER', format: 'TEXT', text, ...(positionalVariables(text).length > 0 && example !== '' ? { example: { header_text: [example] } } : {}) });
  } else if (header.format === 'DOCUMENT') {
    components.push({ type: 'HEADER', format: 'DOCUMENT', ...(opts.headerHandle ? { example: { header_handle: [opts.headerHandle] } } : {}) });
  }
  const variables = alignedVariables(draft);
  const examples = variables.map((v) => v.example);
  components.push({ type: 'BODY', text: draft.body.trim(), ...(variables.length > 0 && examples.every((e) => e !== '') ? { example: { body_text: [examples] } } : {}) });
  const footer = (draft.footer ?? '').trim();
  if (footer !== '') components.push({ type: 'FOOTER', text: footer });
  const buttons = orderedButtons(draft.buttons).map((b) => {
    if (b.type === 'QUICK_REPLY') return { type: 'QUICK_REPLY', text: b.text.trim() };
    if (b.type === 'URL') return { type: 'URL', text: b.text.trim(), url: b.url.trim() };
    return { type: 'PHONE_NUMBER', text: b.text.trim(), phone_number: b.phoneNumber.trim() };
  });
  if (buttons.length > 0) components.push({ type: 'BUTTONS', buttons });
  return components;
}

/** The mapping stored with an authored template: body sources by position, quick-reply intents by button index. */
export function templateMappingOf(draft: TemplateDraft): { body: Record<string, TemplateVariableSource>; buttons: Record<string, QuickReplyIntentValue> } {
  const body = Object.fromEntries(alignedVariables(draft).map((v) => [v.position, v.source]));
  const buttons: Record<string, QuickReplyIntentValue> = {};
  orderedButtons(draft.buttons).forEach((b, index) => {
    if (b.type === 'QUICK_REPLY' && b.intent) buttons[String(index)] = b.intent;
  });
  return { body, buttons };
}

/** The variable schema stored with an authored template (one entry per body position, with its example). */
export function authoredVariableSchema(draft: TemplateDraft): Array<{ name: string; component: 'BODY'; source: TemplateVariableSource; example: string }> {
  return alignedVariables(draft).map((v) => ({ name: v.position, component: 'BODY' as const, source: v.source, example: v.example }));
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isUtilityTrigger(value: unknown): value is UtilityTrigger {
  return typeof value === 'string' && (UTILITY_TRIGGERS as readonly string[]).includes(value);
}

/**
 * The draft a stored authored template stands for (to edit it again): components back into header,
 * body, footer and buttons; examples from the variable schema (or the body example); sources and
 * button intents from the mapping. Unknown parts are dropped, never invented.
 */
export function draftFromStored(row: {
  name: string;
  language: string;
  category: string;
  components: unknown;
  variableSchema: unknown;
  variableMap: unknown;
  utilityTrigger: string | null;
  headerMediaId: string | null;
}): TemplateDraft {
  const list = Array.isArray(row.components) ? row.components.map(record) : [];
  const byType = (t: string) => list.find((c) => str(c.type).toUpperCase() === t) ?? null;
  const headerC = byType('HEADER');
  const bodyC = byType('BODY');
  const footerC = byType('FOOTER');
  const buttonsC = byType('BUTTONS');
  const map = record(row.variableMap);
  const bodySources = record(map.body);
  const buttonIntents = record(map.buttons);
  const schema = Array.isArray(row.variableSchema) ? row.variableSchema.map(record) : [];
  const bodyText = str(bodyC?.text);
  const bodyExamples = Array.isArray(record(bodyC?.example).body_text) ? ((record(bodyC?.example).body_text as unknown[])[0] as unknown) : null;
  const variables: DraftVariable[] = positionalVariables(bodyText).map((position, i) => {
    const fromSchema = schema.find((s) => str(s.name) === position);
    const example = str(fromSchema?.example) || (Array.isArray(bodyExamples) ? str(bodyExamples[i]) : '');
    const source = str(bodySources[position]);
    return { position, source: isTemplateVariableSource(source) ? source : 'manual', example };
  });
  let header: DraftHeader = { format: 'NONE' };
  if (headerC) {
    const format = (str(headerC.format) || 'TEXT').toUpperCase();
    if (format === 'DOCUMENT') header = { format: 'DOCUMENT', mediaId: row.headerMediaId };
    else if (format === 'TEXT') {
      const examples = record(headerC.example).header_text;
      header = { format: 'TEXT', text: str(headerC.text), example: Array.isArray(examples) && typeof examples[0] === 'string' ? examples[0] : null };
    }
  }
  const rawButtons = Array.isArray(buttonsC?.buttons) ? buttonsC.buttons.map(record) : [];
  const buttons: DraftButton[] = rawButtons.flatMap((b, index): DraftButton[] => {
    const type = str(b.type).toUpperCase();
    if (type === 'QUICK_REPLY') {
      const intent = str(buttonIntents[String(index)]);
      return [{ type: 'QUICK_REPLY', text: str(b.text), intent: intent === 'QUOTE' || intent === 'CALL' || intent === 'STOP' ? intent : null }];
    }
    if (type === 'URL') return [{ type: 'URL', text: str(b.text), url: str(b.url) }];
    if (type === 'PHONE_NUMBER') return [{ type: 'PHONE_NUMBER', text: str(b.text), phoneNumber: str(b.phone_number) }];
    return [];
  });
  const category: StudioCategory = row.category.trim().toUpperCase() === 'UTILITY' ? 'UTILITY' : 'MARKETING';
  return {
    category,
    language: row.language,
    name: row.name,
    utilityTrigger: isUtilityTrigger(row.utilityTrigger) ? row.utilityTrigger : null,
    header,
    body: bodyText,
    variables,
    footer: footerC ? str(footerC.text) : null,
    buttons,
  };
}

/** A new, empty draft for the category the person chose first. */
export function emptyDraft(category: StudioCategory, language = 'en'): TemplateDraft {
  return { category, language, name: '', utilityTrigger: null, header: { format: 'NONE' }, body: '', variables: [], footer: null, buttons: defaultButtons(category) };
}

/** Switches the category of a draft: the Stop button follows MARKETING, the trigger follows UTILITY. */
export function withCategory(draft: TemplateDraft, category: StudioCategory): TemplateDraft {
  if (draft.category === category) return draft;
  const withoutStop = draft.buttons.filter((b) => !(b.type === 'QUICK_REPLY' && b.intent === 'STOP'));
  const buttons = category === 'MARKETING' ? [...defaultButtons('MARKETING'), ...withoutStop] : withoutStop;
  return { ...draft, category, buttons, utilityTrigger: category === 'UTILITY' ? draft.utilityTrigger : null };
}
