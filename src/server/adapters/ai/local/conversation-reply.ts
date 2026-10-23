/**
 * Local generator for the `conversation_reply` task (ADR-122): the DEMO answer to a customer's
 * service question, labelled `local-deterministic` ("Local template", never AI). No network.
 *
 * It reads the same data block a provider gets (`data.business`, `data.catalog`,
 * `data.conversation`, see services/ai/conversation-reply.ts) and is keyword-aware over the catalog:
 *  - the services the customer's last message names (distinctive words of a service name, at least
 *    four letters, plurals folded), best match first, at most three;
 *  - what is asked: the timeline ("how long", "timeline", "days", ...), what is included ("include",
 *    "features", "what do I get", ...), or the service in general;
 *  - a general question or a greeting lists the catalog by name and asks which one to explain.
 * Every sentence is built from catalog text and fixed phrases, so it never writes an amount, link or
 * contact the catalog does not hold (the caller's output policy still checks it). A price, quote or
 * call question, or an empty catalog, is reported as not a FAQ with `escalate: true` (the reply
 * guard routes those away first; this is the generator's own safety net). Phrasing choices that the
 * input does not fix are keyed by the seed, so the same input always gives the same output.
 */
import { z } from 'zod';
import type { LocalTaskInput } from '../local-deterministic';

const inputSchema = z.object({
  data: z
    .object({
      business: z.string(),
      catalog: z.array(z.object({ name: z.string(), description: z.string(), typicalTimelineDays: z.number().int().nullable() }).loose()),
      conversation: z.array(z.object({ from: z.enum(['customer', 'business']), text: z.string() })),
    })
    .loose(),
});

type Service = z.infer<typeof inputSchema>['data']['catalog'][number];

export type LocalConversationReply = { reply: string; intent: 'service_faq' | 'quote_request' | 'call_request' | 'out_of_scope'; escalate: boolean };

const MAX_ANSWERED = 3;
const MAX_LISTED = 6;
const DESCRIPTION_MAX = 280;

/** Words of a service name that say nothing about which service is meant. */
const GENERIC = new Set(['service', 'services', 'plan', 'plans', 'package', 'packages', 'with', 'from', 'your', 'full', 'single', 'basic', 'standard', 'premium', 'custom', 'complete', 'setup', 'pages', 'page']);
const TIMELINE = /\b(?:how long|how many (?:days|weeks)|timeline|time ?frame|duration|turnaround|deliver(?:y|ed)?|ready|days?|weeks?|months?|when (?:can|will|would))\b/;
const INCLUDED = /\b(?:includ(?:e|es|ed|ing)|features?|what do i get|what(?:'s| is) in|comes? with|scope|details?|what does it cover|covers?)\b/;
const PRICE = /\b(?:price|prices|pricing|cost|costs|how much|quote|quotation|estimate|budget|rate|rates|fee|fees|charges?)\b|₹|\brs\.?\s*\d/;
const CALL = /\b(?:call me|call back|callback|phone call|ring me|schedule a call|book a call)\b/;

const OPENERS = ['Here is what', 'Happy to help. This is what', 'Sure. Here is what'] as const;
const CLOSERS = ['Would you like a quotation? Reply here and our team will prepare one.', 'If you would like a quotation, reply here and our team will prepare one.'] as const;

function stem(word: string): string {
  return word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word;
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 0)
      .map(stem),
  );
}

function matchServices(text: string, catalog: readonly Service[]): Service[] {
  const asked = words(text);
  const scored: Array<{ s: Service; score: number; order: number }> = [];
  catalog.forEach((s, order) => {
    let score = 0;
    for (const w of words(s.name)) if (w.length >= 4 && !GENERIC.has(w) && asked.has(w)) score += 1;
    if (score > 0) scored.push({ s, score, order });
  });
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((x) => x.s);
}

function timelinePhrase(days: number | null): string | null {
  if (days === null) return null;
  if (days <= 1) return 'Usually completed within a day.';
  if (days < 14) return `Usually completed within ${days} days.`;
  if (days < 60) return `Usually completed within about ${Math.round(days / 7)} weeks.`;
  return `Usually completed within about ${Math.round(days / 30)} months.`;
}

function sentence(text: string): string {
  const trimmed = Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, DESCRIPTION_MAX).join('').trim();
  if (trimmed === '') return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function listNames(names: readonly string[]): string {
  const shown = names.slice(0, MAX_LISTED);
  if (shown.length === 1) return shown[0]!;
  if (names.length > shown.length) return `${shown.join(', ')} and more`;
  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)!}`;
}

export function generateLocalConversationReply({ message, seed }: LocalTaskInput): LocalConversationReply {
  const parsed = inputSchema.safeParse(message);
  if (!parsed.success) throw new TypeError('local-deterministic generator: unexpected conversation_reply input shape');
  const { business, catalog, conversation } = parsed.data.data;
  const last = [...conversation].reverse().find((m) => m.from === 'customer');
  const text = (last?.text ?? '').normalize('NFKC').toLowerCase();

  if (catalog.length === 0) return { reply: 'A member of our team will reply to you here.', intent: 'out_of_scope', escalate: true };
  if (PRICE.test(text)) return { reply: 'A member of our team will prepare your quotation and share it here.', intent: 'quote_request', escalate: true };
  if (CALL.test(text)) return { reply: 'A member of our team will call you back.', intent: 'call_request', escalate: true };

  const matched = matchServices(text, catalog).slice(0, MAX_ANSWERED);
  const name = business.trim();
  if (matched.length === 0) {
    return { reply: `${name} offers ${listNames(catalog.map((s) => s.name.trim()))}. Which one would you like to know more about?`, intent: 'service_faq', escalate: false };
  }

  const askedTimeline = TIMELINE.test(text);
  const askedIncluded = INCLUDED.test(text);
  const lines = matched.map((s) => {
    const timeline = timelinePhrase(s.typicalTimelineDays);
    const description = sentence(s.description);
    if (askedTimeline && !askedIncluded) {
      return `- ${s.name.trim()}: ${timeline ?? 'We will confirm the timeline with you when we prepare the quotation.'}`;
    }
    if (askedIncluded && !askedTimeline) return `- ${s.name.trim()}: ${description}`;
    return `- ${s.name.trim()}: ${description}${timeline ? ` ${timeline}` : ''}`;
  });
  const opener = OPENERS[seed % OPENERS.length]!;
  const closer = CLOSERS[seed % CLOSERS.length]!;
  return { reply: [`${opener} ${name} can help with:`, ...lines, closer].join('\n'), intent: 'service_faq', escalate: false };
}
