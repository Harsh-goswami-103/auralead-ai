/**
 * Automated reply guard (T21; PRD "automated replies constrained to approved services/facts,
 * escalate uncertainty, complaints and human requests"; L-2, R21, plan §9 "Auto-reply guard intents";
 * ADR-63, amended by ADR-122).
 *
 * Meta's 2026 terms forbid general-purpose assistants on WhatsApp, so an automated reply may only
 * ever say something the business already approved, and the customer's words are never echoed:
 *
 *  1. `classifyReplyIntent` puts one inbound text into exactly one of the seven intents with fixed,
 *     conservative rules (stop > complaint > human_request > call_request > quote_request >
 *     service_faq > out_of_scope). Anything the rules do not recognize is `out_of_scope`, so
 *     uncertainty escalates instead of being answered. It is the pre-gate of every automated reply.
 *  2. `decideAutoReply` maps the intent to a reply:
 *     - complaint, human_request, out_of_scope: a fixed deflection, and the thread escalates to a
 *       person (`escalate: true`);
 *     - stop (a stop request inside longer text; whole-message Stops are applied synchronously by
 *       the webhook, C9): no reply at all, escalated so a person can record the opt-out;
 *     - quote_request, call_request: a fixed acknowledgement (prices and call times come from a
 *       person), escalated; the call acknowledgement may carry the workspace's https booking link;
 *     - service_faq: an answer composed only from approved catalog facts (service name,
 *       description, typical timeline), never prices. The composed text still runs through the
 *       output policy (business-entered text can carry amounts or links); any hit turns the reply
 *       into the fixed handoff with escalation (`OUTPUT_POLICY`). A workspace with no catalog cannot
 *       answer (`NO_APPROVED_FACTS`).
 *
 * ADR-122 supersedes this module's earlier rule that a FAQ answer never comes from a model: only a
 * `service_faq` message may go to the `conversation_reply` model task (./conversation-reply.ts,
 * catalog facts only, the output policy on its text), and every other intent keeps the fixed texts
 * here. The guard's own catalog answer stays the reply in LIVE when the workspace has no AI
 * integration (label `reply-guard`), never a silent switch to another generator.
 *
 * Pure apart from `loadReplyFacts`, which reads the current workspace's catalog through the
 * tenant-scoped client. Untrusted inbound text is capped and stripped of control characters first.
 */
import type { ScopedDb, ScopedTx } from '@/server/db/scoped';
import { foldKeyword, httpsBookingUrl, STOP_KEYWORDS } from '@/server/services/messaging/quick-replies';
import { sanitizeUntrusted, UNTRUSTED_LIMITS } from './context-builder';
import { checkText, type PolicyRule } from './output-policy';

export const REPLY_INTENTS = ['quote_request', 'call_request', 'service_faq', 'stop', 'complaint', 'human_request', 'out_of_scope'] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

/** Every fixed text the guard can send. None contains an amount, a link, a contact or an offer. */
export const FIXED_REPLIES = {
  complaint: 'We are sorry to hear this. A member of our team will look into it and reply to you here personally.',
  human_request: 'Of course. A member of our team will reply to you here personally.',
  out_of_scope: 'I can only help with questions about our services. A member of our team will reply to you here.',
  quote_request: 'Thank you. A member of our team will prepare your quotation and share it here.',
  call_request: 'Thank you. A member of our team will call you back.',
  handoff: 'Thank you for your message. A member of our team will reply to you here.',
} as const;

/**
 * The line that opens the first automated reply of each 24-hour window (ADR-122). "HUMAN" matches
 * the human_request rule, so the customer's answer reaches a person.
 */
export function automatedReplyDisclosure(business: string): string {
  return `${business.trim()}'s automated assistant. Reply HUMAN to talk to a person.`;
}

export type ReplyFacts = {
  business: string;
  /** Only an absolute https URL without credentials is ever used (P4). */
  bookingUrl: string | null;
  services: ReadonlyArray<{ id: string; code: string; name: string; description: string; timelineDays: number | null }>;
};

export type IntentClassification = { intent: ReplyIntent; matchedServiceIds: string[] };

export type ReplyAction = 'NONE' | 'ANSWER' | 'DEFLECT';
/**
 * Why a reply escalated: the guard's intent; catalog or model text that broke the output policy; no
 * catalog; the model's own escalation or a non-FAQ intent it reported (MODEL_ESCALATED); a model
 * call that failed after its retries (AI_FAILED); the cap on consecutive automated replies
 * (REPLY_CAP).
 */
export type EscalationReason = ReplyIntent | 'OUTPUT_POLICY' | 'NO_APPROVED_FACTS' | 'MODEL_ESCALATED' | 'AI_FAILED' | 'REPLY_CAP';
export type ReplyDecision = {
  intent: ReplyIntent;
  action: ReplyAction;
  /** The exact outbound text, or null when nothing is sent. */
  text: string | null;
  escalate: boolean;
  escalationReason: EscalationReason | null;
  matchedServiceIds: string[];
  /** Output-policy rules the composed FAQ answer broke (field names only, never text). */
  policyRules: PolicyRule[];
};

// ---- Classification ----------------------------------------------------------------------------------

const STOP_SET = new Set(STOP_KEYWORDS.map(foldKeyword));
const STOP_PHRASE = /\b(?:stop (?:messaging|texting|sending|contacting|calling)|(?:don'?t|do not) (?:message|text|contact|send)|unsubscribe|opt[- ]?out|remove me|leave me alone)\b/;
const COMPLAINT =
  /\b(?:complain\w*|refund\w*|worst|terrible|horrible|awful|disappoint\w*|unhappy|not happy|not satisfied|dissatisfied|cheat\w*|fraud\w*|scam\w*|rude|pathetic|useless|angry|furious|bad (?:service|experience|treatment|behaviou?r)|consumer (?:court|forum)|legal action|lawyer|police)\b/;
const COMPLAINT_HI = ['शिकायत', 'धोखा', 'बेकार', 'गुस्सा'];
const HUMAN =
  /\b(?:human|real person|actual person|real human|not a bot|are you a (?:bot|robot|chatbot)|(?:talk|speak|chat) (?:to|with) (?:a |an |the |your |some )?(?:human|person|someone|somebody|agent|representative|manager|owner|staff|team|doctor|people)|customer (?:care|service|support))\b/;
const HUMAN_HI = ['इंसान', 'किसी से बात', 'बात करनी'];
const CALL = /\b(?:call me|call back|callback|call-back|give me a call|phone call|ring me|(?:can|could|would|please) you call|please call|schedule a call|book a call)\b/;
const CALL_HI = ['कॉल', 'फोन करें', 'फ़ोन करें'];
const QUOTE = /\b(?:quote|quotes|quotation|quotations|estimate|estimates|price|prices|pricing|cost|costs|how much|rate|rates|charge|charges|fee|fees|budget|tariff)\b/;
const QUOTE_HI = ['कितना', 'कोटेशन', 'दाम', 'कीमत', 'रेट'];
const FAQ_GENERIC =
  /\b(?:services?|what do you (?:do|offer|provide|make|build)|do you (?:do|offer|provide|have|make|treat|build|design|develop|create)|available|availability|how long|timeline|duration|turnaround|treatments?|procedures?|appointments?|opening hours|timings?|includ(?:e|es|ed|ing)|features?|what do i get|websites?|web design|landing pages?|e-?commerce|online store|hosting|portfolio|maintenance)\b/;
const GREETING = /^(?:hi+|hello+|hey+|hii+|namaste|namaskar|good (?:morning|afternoon|evening)|नमस्ते)\W*$/u;

/** Words of a service name that say nothing about which service is meant. */
const GENERIC_WORDS = new Set(['service', 'services', 'plan', 'plans', 'package', 'packages', 'with', 'from', 'your', 'session', 'sessions', 'visit', 'full', 'single', 'course', 'treatment', 'treatments', 'clinic', 'in-clinic']);

function stem(word: string): string {
  return word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0)
    .map(stem);
}

function includesAny(text: string, words: readonly string[]): boolean {
  return words.some((w) => text.includes(w));
}

/** Catalog services the text names (by a distinctive name word or the service code), best first. */
function matchServices(text: string, facts: ReplyFacts): string[] {
  const words = new Set(tokens(text));
  const scored: Array<{ id: string; score: number; order: number }> = [];
  facts.services.forEach((s, order) => {
    let score = 0;
    for (const w of new Set(tokens(s.name))) if (w.length >= 4 && !GENERIC_WORDS.has(w) && words.has(w)) score += 1;
    const code = s.code.toLowerCase();
    if (code.length >= 3 && words.has(code)) score += 2;
    if (score > 0) scored.push({ id: s.id, score, order });
  });
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((s) => s.id);
}

export function classifyReplyIntent(rawText: string, facts: ReplyFacts): IntentClassification {
  const text = sanitizeUntrusted(rawText, UNTRUSTED_LIMITS.inboundText).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const matchedServiceIds = matchServices(text, facts);
  const is = (intent: ReplyIntent): IntentClassification => ({ intent, matchedServiceIds });
  if (text === '') return is('out_of_scope');
  if (STOP_SET.has(foldKeyword(text)) || STOP_PHRASE.test(text)) return is('stop');
  if (COMPLAINT.test(text) || includesAny(text, COMPLAINT_HI)) return is('complaint');
  if (HUMAN.test(text) || includesAny(text, HUMAN_HI)) return is('human_request');
  if (CALL.test(text) || includesAny(text, CALL_HI)) return is('call_request');
  if (QUOTE.test(text) || includesAny(text, QUOTE_HI)) return is('quote_request');
  if (matchedServiceIds.length > 0 || FAQ_GENERIC.test(text) || GREETING.test(text)) return is('service_faq');
  return is('out_of_scope');
}

// ---- Decision ----------------------------------------------------------------------------------------

const MAX_ANSWERED_SERVICES = 3;
const MAX_LISTED_SERVICES = 6;
const DESCRIPTION_MAX = 280;

function timelinePhrase(days: number | null): string | null {
  if (days === null) return null;
  if (days <= 1) return 'Usually completed within a day.';
  if (days < 14) return `Usually completed within ${days} days.`;
  if (days < 60) return `Usually completed within about ${Math.round(days / 7)} weeks.`;
  return `Usually completed within about ${Math.round(days / 30)} months.`;
}

function sentence(text: string): string {
  const trimmed = Array.from(text.trim()).slice(0, DESCRIPTION_MAX).join('').trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function listNames(names: readonly string[]): string {
  const shown = names.slice(0, MAX_LISTED_SERVICES);
  const more = names.length > shown.length;
  if (shown.length === 1) return shown[0]!;
  if (more) return `${shown.join(', ')} and more`;
  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)!}`;
}

function composeFaqAnswer(facts: ReplyFacts, matched: readonly string[]): string {
  if (matched.length === 0) {
    return `${facts.business} offers ${listNames(facts.services.map((s) => s.name.trim()))}. Which one would you like to know more about?`;
  }
  const byId = new Map(facts.services.map((s) => [s.id, s]));
  const lines = matched.slice(0, MAX_ANSWERED_SERVICES).map((id) => {
    const s = byId.get(id)!;
    const timeline = timelinePhrase(s.timelineDays);
    return `- ${s.name.trim()}: ${sentence(s.description)}${timeline ? ` ${timeline}` : ''}`;
  });
  return [`Here is what ${facts.business} can help with:`, ...lines, 'Would you like a quotation? Reply here and our team will prepare one.'].join('\n');
}

export function decideAutoReply(text: string, facts: ReplyFacts): ReplyDecision {
  const { intent, matchedServiceIds } = classifyReplyIntent(text, facts);
  const base = { intent, matchedServiceIds, policyRules: [] as PolicyRule[] };
  switch (intent) {
    case 'stop':
      return { ...base, action: 'NONE', text: null, escalate: true, escalationReason: 'stop' };
    case 'complaint':
    case 'human_request':
    case 'out_of_scope':
      return { ...base, action: 'DEFLECT', text: FIXED_REPLIES[intent], escalate: true, escalationReason: intent };
    case 'quote_request':
      return { ...base, action: 'ANSWER', text: FIXED_REPLIES.quote_request, escalate: true, escalationReason: intent };
    case 'call_request': {
      const url = httpsBookingUrl(facts.bookingUrl);
      const reply = url ? `${FIXED_REPLIES.call_request} You can also pick a time that suits you here: ${url}` : FIXED_REPLIES.call_request;
      return { ...base, action: 'ANSWER', text: reply, escalate: true, escalationReason: intent };
    }
    case 'service_faq': {
      if (facts.services.length === 0) return { ...base, action: 'DEFLECT', text: FIXED_REPLIES.handoff, escalate: true, escalationReason: 'NO_APPROVED_FACTS' };
      const answer = composeFaqAnswer(facts, matchedServiceIds);
      const policyRules = checkText(answer, { allowedEmails: [], allowedPhones: [], allowedUrls: [] });
      if (policyRules.length > 0) return { ...base, policyRules, action: 'DEFLECT', text: FIXED_REPLIES.handoff, escalate: true, escalationReason: 'OUTPUT_POLICY' };
      return { ...base, action: 'ANSWER', text: answer, escalate: false, escalationReason: null };
    }
  }
}

// ---- Facts -------------------------------------------------------------------------------------------

/** The approved facts of the current workspace: its name, live catalog and booking link. */
export async function loadReplyFacts(db: ScopedDb | ScopedTx, workspaceId: string): Promise<ReplyFacts> {
  const workspace = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } });
  const settings = await db.workspaceSettings.findFirst({ select: { bookingUrl: true } });
  const services = await db.service.findMany({ where: { archivedAt: null }, orderBy: [{ code: 'asc' }], select: { id: true, code: true, name: true, description: true, defaultTimelineDays: true } });
  return {
    business: workspace.name,
    bookingUrl: httpsBookingUrl(settings?.bookingUrl ?? null),
    services: services.map((s) => ({ id: s.id, code: s.code, name: s.name, description: s.description, timelineDays: s.defaultTimelineDays })),
  };
}
