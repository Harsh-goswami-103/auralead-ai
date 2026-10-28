/**
 * Local generator for the `handoff_summary` task (ADR-124, lead-gen slice F5): the DEMO handoff
 * summary, labelled `local-deterministic` ("Local template", never AI). It reads the same JSON data
 * block a provider gets (services/ai/handoff-summary.ts) and writes three plain lines from fixed
 * phrases: what the customer asked about (catalog services and common topics named in their
 * messages), what the business sent (message count and quotation status) and the next step. It
 * never repeats the customer's text, so nothing they wrote (links, numbers, instructions) reaches
 * the summary. Same input, same output; the seed picks only between equivalent openers.
 */
import { z } from 'zod';
import type { LocalTaskInput } from '../local-deterministic';

const inputSchema = z.object({
  data: z
    .object({
      workspace: z.object({ name: z.string() }).loose(),
      lead: z.object({ displayName: z.string().nullable() }).loose(),
      operatorNote: z.string().nullable(),
      messages: z.array(z.object({ from: z.enum(['customer', 'business']), kind: z.string(), text: z.string().nullable() }).loose()),
      quotes: z.array(z.object({ number: z.string(), status: z.string() }).loose()),
      openCallRequest: z.boolean(),
      catalog: z.array(z.object({ name: z.string() }).loose()),
    })
    .loose(),
});

type Data = z.infer<typeof inputSchema>['data'];

const MAX_TOPICS = 4;
const TOPICS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'prices or a quotation', pattern: /\b(?:price|prices|pricing|cost|costs|rate|rates|charge|charges|quote|quotation|budget|kitna|fees?)\b/i },
  { label: 'timelines', pattern: /\b(?:when|how long|timeline|deadline|days|weeks|deliver(?:y|ed)?)\b/i },
  { label: 'a call back', pattern: /\b(?:call|phone|ring)\b/i },
  { label: 'samples of past work', pattern: /\b(?:portfolio|samples?|examples?|previous work|past work)\b/i },
];
const OPENERS = ['The customer sent', 'The customer wrote'] as const;
/** Links are not topics (a domain such as example.com must not read as "examples"). */
const LINKS = /\b(?:https?:\/\/|www\.)\S+/gi;

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4),
  );

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The services the customer's words point at. A service counts only by the words it shares with
 * the customer; the best-matching one is named. When several services tie (the customer said
 * "website" and two services have it in their name) none is claimed: the shared word is reported
 * as a kind of service instead, so the summary never says they asked about what they did not.
 */
function servicesAskedAbout(catalog: Data['catalog'], said: ReadonlySet<string>): string[] {
  const scored = catalog.map((s) => ({ name: s.name, hits: [...words(s.name)].filter((w) => said.has(w)) })).filter((s) => s.hits.length > 0);
  if (scored.length === 0) return [];
  const best = Math.max(...scored.map((s) => s.hits.length));
  const top = scored.filter((s) => s.hits.length === best);
  if (top.length === 1) return [top[0]!.name];
  const shared = top[0]!.hits.filter((w) => top.every((s) => s.hits.includes(w)));
  return [`${shared[0] ?? top[0]!.hits[0]!} services`];
}

function asked(data: Data, seed: number): string {
  const inbound = data.messages.filter((m) => m.from === 'customer');
  if (inbound.length === 0) return 'The customer has not written yet.';
  const text = inbound
    .map((m) => m.text ?? '')
    .join('\n')
    .replace(LINKS, ' ');
  const said = words(text);
  const services = servicesAskedAbout(data.catalog, said);
  const topics = TOPICS.filter((t) => t.pattern.test(text)).map((t) => t.label);
  const named = [...services, ...topics].slice(0, MAX_TOPICS);
  const opener = `${OPENERS[seed % OPENERS.length]} ${plural(inbound.length, 'message', 'messages')}`;
  return named.length > 0 ? `${opener} and asked about ${listOf(named)}.` : `${opener}; none of them named a service from the catalog.`;
}

const QUOTE_WORDS: Readonly<Record<string, string>> = { SENT: 'sent', VIEWED: 'sent and opened', ACCEPTED: 'accepted', DRAFT: 'drafted, not sent yet', APPROVED: 'approved, not sent yet' };

function promised(data: Data): string {
  const sent = data.messages.filter((m) => m.from === 'business').length;
  const messages = sent === 0 ? 'The team has not sent a message yet.' : `The team sent ${plural(sent, 'message', 'messages')}.`;
  const quote = data.quotes.find((q) => QUOTE_WORDS[q.status] !== undefined);
  const quotePart = quote ? ` Quotation ${quote.number} was ${QUOTE_WORDS[quote.status]}.` : ' No quotation was sent yet.';
  return `${messages}${quotePart}`;
}

function nextStep(data: Data): string {
  const statuses = new Set(data.quotes.map((q) => q.status));
  const inboundText = data.messages
    .filter((m) => m.from === 'customer')
    .map((m) => m.text ?? '')
    .join('\n');
  let step: string;
  if (data.openCallRequest) step = 'Call the customer back: they asked for a call.';
  else if (statuses.has('ACCEPTED')) step = 'Confirm the start of the work for the accepted quotation.';
  else if (statuses.has('SENT') || statuses.has('VIEWED')) step = 'Follow up on the quotation that was sent.';
  else if (TOPICS[0]!.pattern.test(inboundText)) step = 'Prepare a quotation from the price list and send it.';
  else step = 'Reply to the customer and offer a quotation.';
  return data.operatorNote ? `${step} Read the operator's note first.` : step;
}

export function generateLocalHandoffSummary(input: LocalTaskInput): { asked: string; promised: string; nextStep: string } {
  const parsed = inputSchema.safeParse(input.message);
  if (!parsed.success) throw new TypeError('local-deterministic generator: unexpected handoff_summary input shape');
  const data = parsed.data.data;
  return { asked: asked(data, input.seed), promised: promised(data), nextStep: nextStep(data) };
}
