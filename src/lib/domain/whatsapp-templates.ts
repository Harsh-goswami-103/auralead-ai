/**
 * WhatsApp template shapes and mappings (T32; ADR-17, P12, plan §5.5). Framework-free, browser-safe:
 * shared by the template sync (what a synced template needs to be sendable), the mapping form,
 * the Cloud API adapter (which components a send carries) and the dispatch path (quick-reply
 * payloads set per send).
 *
 * Templates are authored in WhatsApp Manager and arrive with the provider's raw `components`
 * (HEADER, BODY, FOOTER, BUTTONS with `{{n}}` positional variables). This module only reads them;
 * status and category stay raw provider strings elsewhere (never enums, plan §5.1).
 *
 * What the send path supports (documented shape, UNVERIFIED until a live check, docs/integrations.md):
 *  - positional BODY variables `{{1}}..{{n}}`, filled in order from the message's variables;
 *  - a DOCUMENT header, filled with the uploaded quotation PDF (P2) when the send carries one;
 *  - a TEXT header without variables, a FOOTER, static URL and phone buttons (no parameters);
 *  - QUICK_REPLY buttons, each given the stable payload id of its mapped intent (ADR-62).
 * Anything else (named parameters, header variables, image/video/location headers, URL buttons
 * with a variable) is reported as not sendable from this app instead of failing at the provider.
 *
 * Per-lead variables (ADR-123): `resolveLeadTemplateVariables` fills the positions mapped to a lead
 * or workspace source for one lead, for bulk sends and the composer. It reports a missing value
 * and never invents one.
 */

export const TEMPLATE_INTENT_VALUES = ['FIRST_TOUCH', 'QUOTE_READY', 'FOLLOW_UP', 'CALL_ACK'] as const;
export type TemplateIntentValue = (typeof TEMPLATE_INTENT_VALUES)[number];

/** Quick-reply intents a template button may be mapped to (payload ids live in messaging/quick-replies.ts). */
export const QUICK_REPLY_INTENT_VALUES = ['QUOTE', 'CALL', 'STOP'] as const;
export type QuickReplyIntentValue = (typeof QUICK_REPLY_INTENT_VALUES)[number];

export const QUICK_REPLY_INTENT_LABELS: Readonly<Record<QuickReplyIntentValue, string>> = {
  QUOTE: 'Send the quotation',
  CALL: 'Request a call',
  STOP: 'Stop messages',
};

/** Where a positional variable's value comes from (documentation for the people and the AI that fill it). */
export const TEMPLATE_VARIABLE_SOURCES = {
  'lead.displayName': 'Customer name',
  'lead.firstName': 'Customer first name',
  'lead.city': 'Customer city',
  'lead.category': 'Customer business category',
  'workspace.name': 'Business name',
  'quote.number': 'Quotation number',
  'quote.total': 'Quotation total',
  'quote.validUntil': 'Quotation valid until',
  'ai.firstTouch': 'AI-drafted first message text',
  manual: 'Typed by the person sending',
} as const;
export type TemplateVariableSource = keyof typeof TEMPLATE_VARIABLE_SOURCES;

export function isTemplateVariableSource(value: string): value is TemplateVariableSource {
  return Object.prototype.hasOwnProperty.call(TEMPLATE_VARIABLE_SOURCES, value);
}

// ---- Per-lead variables (ADR-123) ---------------------------------------------------------------

/** The sources one lead and its workspace resolve. None is contact data (no phone, no email). */
export const LEAD_TEMPLATE_VARIABLE_SOURCES = ['lead.firstName', 'lead.displayName', 'lead.city', 'lead.category', 'workspace.name'] as const;
export type LeadTemplateVariableSource = (typeof LEAD_TEMPLATE_VARIABLE_SOURCES)[number];

const LEAD_SOURCE_SET = new Set<string>(LEAD_TEMPLATE_VARIABLE_SOURCES);

export function isLeadTemplateVariableSource(value: string): value is LeadTemplateVariableSource {
  return LEAD_SOURCE_SET.has(value);
}

/** Longest value one body parameter may carry (the bulk form's limit, BulkTemplateVariables). */
export const TEMPLATE_VARIABLE_MAX_LENGTH = 200;

/** The lead facts the resolver reads (a Lead row satisfies it). */
export type TemplateLeadFacts = { displayName: string | null; city: string | null; category: string | null };
/** The workspace facts the resolver reads (a Workspace row satisfies it). */
export type TemplateWorkspaceFacts = { name: string | null };

/** What a send fills: the template's body positions, their mapped sources and the values the caller already has. */
export type LeadTemplateVariableMapping = {
  /** The body positions the template needs (`templateShape(...).bodyVariables`). */
  positions: readonly string[];
  /** Source by position (`parseTemplateMapping(...).body`); an unmapped position is `manual`. */
  sources: Readonly<Record<string, TemplateVariableSource>>;
  /**
   * Values by position: typed by the sender for `manual` positions, or computed by the caller for
   * the sources this resolver cannot see (`quote.*`, `ai.firstTouch`). Lead and workspace sources
   * ignore them, so per-lead values stay per lead.
   */
  literals?: Readonly<Record<string, string>>;
};

/**
 * Why a position has no value: the lead or workspace has none (NO_VALUE), a manual position was
 * left empty (NOT_PROVIDED), a quote or AI source was not supplied by the caller (NEEDS_CONTEXT),
 * or the value is longer than one parameter may be (TOO_LONG; never cut).
 */
export type MissingTemplateVariableReason = 'NO_VALUE' | 'NOT_PROVIDED' | 'NEEDS_CONTEXT' | 'TOO_LONG';
export type MissingTemplateVariable = { position: string; source: TemplateVariableSource; reason: MissingTemplateVariableReason };

export type LeadTemplateVariables = {
  /** True when every position has a value. */
  ok: boolean;
  /** Values by position, numerically ordered; only positions that resolved (never a placeholder). */
  values: Record<string, string>;
  missing: MissingTemplateVariable[];
};

/** Words skipped before a first name (titles, not names). */
const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'shri', 'sri', 'smt', 'kumari']);

/**
 * The first name in a display name: the first word after any title, letters (with combining marks),
 * apostrophes and hyphens only. A name that starts with an article ("The Bake House") or a number
 * is a business name and has none: the caller maps `lead.displayName` instead.
 */
export function leadFirstName(displayName: string | null | undefined): string | null {
  const words = (displayName ?? '').trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && HONORIFICS.has(words[i]!.replace(/\.$/, '').toLowerCase())) i++;
  const word = words[i];
  if (word === undefined || word.toLowerCase() === 'the') return null;
  const name = word.replace(/[^\p{L}\p{M}'-]/gu, '').replace(/^['-]+|['-]+$/g, '');
  if (!/^\p{L}/u.test(name)) return null;
  return name;
}

/** One line: whitespace runs (newlines, tabs, repeated spaces) folded to one space, trimmed. */
function oneLine(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function leadSourceValue(source: LeadTemplateVariableSource, lead: TemplateLeadFacts, workspace: TemplateWorkspaceFacts): string | null {
  switch (source) {
    case 'lead.firstName':
      return leadFirstName(lead.displayName);
    case 'lead.displayName':
      return lead.displayName;
    case 'lead.city':
      return lead.city;
    case 'lead.category':
      return lead.category;
    case 'workspace.name':
      return workspace.name;
  }
}

/**
 * Positional body values for one lead (pure). Lead and workspace sources come from the rows;
 * `manual` and unmapped positions keep the caller's literal; quote and AI sources take a literal the
 * caller computed. Anything without a value is listed in `missing`, never filled with a stand-in.
 */
export function resolveLeadTemplateVariables(mapping: LeadTemplateVariableMapping, lead: TemplateLeadFacts, workspace: TemplateWorkspaceFacts): LeadTemplateVariables {
  const positions = [...new Set(mapping.positions.filter((p) => /^\d+$/.test(p)).map((p) => String(Number(p))))].sort((a, b) => Number(a) - Number(b));
  const values: Record<string, string> = {};
  const missing: MissingTemplateVariable[] = [];
  for (const position of positions) {
    const source: TemplateVariableSource = mapping.sources[position] ?? 'manual';
    const fromLead = isLeadTemplateVariableSource(source);
    const value = oneLine(fromLead ? leadSourceValue(source, lead, workspace) : mapping.literals?.[position]);
    if (value === '') missing.push({ position, source, reason: fromLead ? 'NO_VALUE' : source === 'manual' ? 'NOT_PROVIDED' : 'NEEDS_CONTEXT' });
    else if (value.length > TEMPLATE_VARIABLE_MAX_LENGTH) missing.push({ position, source, reason: 'TOO_LONG' });
    else values[position] = value;
  }
  return { ok: missing.length === 0, values, missing };
}

export type NotSendableReason = 'NAMED_PARAMETERS' | 'HEADER_VARIABLES' | 'MEDIA_HEADER' | 'URL_BUTTON_VARIABLE' | 'NO_BODY';

export const NOT_SENDABLE_LABELS: Readonly<Record<NotSendableReason, string>> = {
  NAMED_PARAMETERS: 'Uses named parameters, which this app does not fill',
  HEADER_VARIABLES: 'Has a header variable, which this app does not fill',
  MEDIA_HEADER: 'Has an image, video or location header, which this app does not send',
  URL_BUTTON_VARIABLE: 'Has a URL button with a variable, which this app does not fill',
  NO_BODY: 'Has no body text',
};

export type TemplateShape = {
  /** Positional body variables, numerically ordered: ['1', '2', ...]. */
  bodyVariables: string[];
  /** Raw upper-cased header format (TEXT, DOCUMENT, IMAGE, ...) or null without a header. */
  headerFormat: string | null;
  /** The header takes the attached document (P2). */
  documentHeader: boolean;
  /** QUICK_REPLY buttons with their index among all of the template's buttons. */
  quickReplies: Array<{ index: number; text: string }>;
  sendable: { ok: true } | { ok: false; reason: NotSendableReason };
};

const POSITIONAL_RE = /\{\{\s*(\d+)\s*\}\}/g;
const ANY_VARIABLE_RE = /\{\{\s*[^}]+\s*\}\}/;
const NAMED_RE = /\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/;

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function positional(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(POSITIONAL_RE)) found.add(String(Number(m[1])));
  return [...found].sort((a, b) => Number(a) - Number(b));
}

/** Reads a template's raw provider components (and its raw `parameter_format`, when known). */
export function templateShape(components: unknown, parameterFormat?: string | null): TemplateShape {
  const list = Array.isArray(components) ? components.map(record) : [];
  const byType = (t: string) => list.find((c) => text(c.type).toUpperCase() === t) ?? null;
  const body = byType('BODY');
  const header = byType('HEADER');
  const buttonsComponent = byType('BUTTONS');
  const buttons = Array.isArray(buttonsComponent?.buttons) ? buttonsComponent.buttons.map(record) : [];

  const bodyText = text(body?.text);
  const headerFormat = header ? (text(header.format) || 'TEXT').toUpperCase() : null;
  const quickReplies = buttons.flatMap((b, index) => (text(b.type).toUpperCase() === 'QUICK_REPLY' ? [{ index, text: text(b.text) }] : []));
  const shape = (sendable: TemplateShape['sendable']): TemplateShape => ({
    bodyVariables: positional(bodyText),
    headerFormat,
    documentHeader: headerFormat === 'DOCUMENT',
    quickReplies,
    sendable,
  });

  if (!body || bodyText.trim() === '') return shape({ ok: false, reason: 'NO_BODY' });
  if ((parameterFormat ?? '').toUpperCase() === 'NAMED' || NAMED_RE.test(bodyText)) return shape({ ok: false, reason: 'NAMED_PARAMETERS' });
  if (headerFormat === 'TEXT' && ANY_VARIABLE_RE.test(text(header?.text))) return shape({ ok: false, reason: 'HEADER_VARIABLES' });
  if (headerFormat !== null && headerFormat !== 'TEXT' && headerFormat !== 'DOCUMENT') return shape({ ok: false, reason: 'MEDIA_HEADER' });
  const dynamicUrl = buttons.some((b) => text(b.type).toUpperCase() === 'URL' && ANY_VARIABLE_RE.test(text(b.url)));
  if (dynamicUrl) return shape({ ok: false, reason: 'URL_BUTTON_VARIABLE' });
  return shape({ ok: true });
}

/** A template's mapping: body variable sources by position and quick-reply intents by button index. */
export type TemplateMapping = { body: Record<string, TemplateVariableSource>; buttons: Record<string, QuickReplyIntentValue> };

const QUICK_REPLY_SET = new Set<string>(QUICK_REPLY_INTENT_VALUES);

/**
 * Parses `WhatsAppTemplate.variableMap`. The current shape is `{ body: {"1": source}, buttons:
 * {"0": intent} }`; the T28 DEMO sync wrote a flat `{"1": source}` map, read as body sources.
 * Unknown keys and values are dropped.
 */
export function parseTemplateMapping(variableMap: unknown): TemplateMapping {
  const raw = record(variableMap);
  const hasNested = 'body' in raw || 'buttons' in raw;
  const bodyRaw = hasNested ? record(raw.body) : raw;
  const body: Record<string, TemplateVariableSource> = {};
  for (const [k, v] of Object.entries(bodyRaw)) {
    if (/^\d+$/.test(k) && typeof v === 'string' && isTemplateVariableSource(v)) body[String(Number(k))] = v;
  }
  const buttons: Record<string, QuickReplyIntentValue> = {};
  for (const [k, v] of Object.entries(hasNested ? record(raw.buttons) : {})) {
    if (/^\d+$/.test(k) && typeof v === 'string' && QUICK_REPLY_SET.has(v)) buttons[String(Number(k))] = v as QuickReplyIntentValue;
  }
  return { body, buttons };
}

/** Keeps only the positions and button indexes the template still has (after a re-sync). */
export function pruneMapping(mapping: TemplateMapping, shape: TemplateShape): TemplateMapping {
  const positions = new Set(shape.bodyVariables);
  const indexes = new Set(shape.quickReplies.map((q) => String(q.index)));
  return {
    body: Object.fromEntries(Object.entries(mapping.body).filter(([k]) => positions.has(k))),
    buttons: Object.fromEntries(Object.entries(mapping.buttons).filter(([k]) => indexes.has(k))),
  };
}

/** The variable schema stored with a synced template: one entry per body position. */
export function variableSchemaOf(shape: TemplateShape, mapping: TemplateMapping): Array<{ name: string; component: 'BODY'; source: TemplateVariableSource | null }> {
  return shape.bodyVariables.map((name) => ({ name, component: 'BODY' as const, source: mapping.body[name] ?? null }));
}
