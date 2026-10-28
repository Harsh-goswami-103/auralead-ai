/**
 * Local generator for the `template_copy` task (ADR-123, slice F4; ADR-18 labelled local output).
 *
 * It reads the same JSON data block a provider gets (`services/ai/template-copy.ts`) and writes
 * WhatsApp template copy from fixed, policy-safe texts for a web-development studio: the category
 * the person chose (never changed), the UTILITY trigger, and a few keywords of the stated purpose
 * pick the text; every remaining choice (which marketing angle, the example first name, the name
 * suffix) is keyed by the seed. It never writes amounts, links, contacts or offers, uses only the
 * positional variables the task allows, and puts every variable between words (Meta refuses one at
 * the start or end of the body). The purpose text itself is never copied into the output.
 */
import { z } from 'zod';
import type { LocalTaskInput } from '../local-deterministic';

const inputSchema = z.object({
  data: z
    .object({
      workspace: z.object({ name: z.string() }),
      category: z.enum(['MARKETING', 'UTILITY']),
      utilityTrigger: z.enum(['CUSTOMER_ASKED', 'MEETING_BOOKED', 'QUOTE_ISSUED']).nullable(),
      purpose: z.string(),
    })
    .loose(),
});

type Source = 'lead.firstName' | 'lead.displayName' | 'lead.city' | 'lead.category' | 'workspace.name';

type Copy = { name: string; headerText: string | null; body: string; footer: string | null; buttons: string[]; sources: Source[] };

const FIRST_NAMES = ['Ravi', 'Priya', 'Arjun', 'Neha', 'Kabir', 'Ananya'] as const;
const EXAMPLES: Readonly<Record<Exclude<Source, 'lead.firstName' | 'workspace.name'>, string>> = { 'lead.displayName': 'Sharma Sweets', 'lead.city': 'Indore', 'lead.category': 'bakery' };

const MARKETING: readonly Copy[] = [
  {
    name: 'website_intro',
    headerText: 'A website for your business',
    body: 'Hello {{1}}, this is {{2}}. We build fast, mobile-friendly websites that help local businesses get found on Google and receive enquiries on WhatsApp. Would you like to see a few examples of our work?',
    footer: 'Tap Stop to opt out',
    buttons: ['See examples'],
    sources: ['lead.firstName', 'workspace.name'],
  },
  {
    name: 'online_presence_plan',
    headerText: 'Get found online',
    body: 'Hello {{1}}, {{2}} here. Customers in {{3}} search online before they visit a shop. A simple website and an updated Google listing can bring you more calls. Shall we share a short plan for your business?',
    footer: 'Tap Stop to opt out',
    buttons: ['Share the plan'],
    sources: ['lead.firstName', 'workspace.name', 'lead.city'],
  },
  {
    name: 'website_refresh',
    headerText: 'Is your website working for you?',
    body: 'Hello {{1}}, {{2}} helps {{3}} businesses turn their website into a steady source of enquiries, with clear pages, quick loading and a WhatsApp button. Would a short call this week suit you?',
    footer: 'Tap Stop to opt out',
    buttons: ['Book a call'],
    sources: ['lead.firstName', 'workspace.name', 'lead.category'],
  },
];

const BROCHURE: Copy = {
  name: 'website_brochure',
  headerText: 'Our website brochure',
  body: 'Hello {{1}}, {{2}} has put together a short brochure on websites for {{3}} businesses: what we build, how long it takes and what you need to start. Reply Yes and we will send it here.',
  footer: 'Tap Stop to opt out',
  buttons: ['Yes, send it'],
  sources: ['lead.firstName', 'workspace.name', 'lead.category'],
};

const UTILITY: Readonly<Record<'CUSTOMER_ASKED' | 'MEETING_BOOKED' | 'QUOTE_ISSUED', Copy>> = {
  CUSTOMER_ASKED: {
    name: 'project_next_steps',
    headerText: 'Your website project',
    body: 'Hello {{1}}, as you asked, here are the next steps for your website project with {{2}}: we will send a short questionnaire about your pages and content, then agree the timeline with you. Reply here with any questions.',
    footer: null,
    buttons: ['Talk to us'],
    sources: ['lead.firstName', 'workspace.name'],
  },
  MEETING_BOOKED: {
    name: 'consultation_confirmed',
    headerText: 'Consultation confirmed',
    body: 'Hello {{1}}, your website consultation with {{2}} is confirmed. We will call you at the booked time to discuss your pages, content and timeline. Reply here if you need to change it.',
    footer: null,
    buttons: ['Change the time'],
    sources: ['lead.firstName', 'workspace.name'],
  },
  QUOTE_ISSUED: {
    name: 'quotation_issued',
    headerText: 'Your quotation is ready',
    body: 'Hello {{1}}, {{2}} has issued the quotation for your website project. Reply here if you have questions about the scope or the timeline.',
    footer: null,
    buttons: ['I have a question'],
    sources: ['lead.firstName', 'workspace.name'],
  },
};

function pick(category: 'MARKETING' | 'UTILITY', trigger: keyof typeof UTILITY | null, purpose: string, seed: number): Copy {
  if (category === 'UTILITY') return UTILITY[trigger ?? 'CUSTOMER_ASKED'];
  const p = purpose.toLowerCase();
  if (/\bbrochures?\b|\bcatalog(?:ue)?\b|\bpdf\b/.test(p)) return BROCHURE;
  if (/\bredesign\b|\brefresh\b|\bold website\b|\bslow\b/.test(p)) return MARKETING[2]!;
  if (/\bgoogle\b|\bfound\b|\bonline\b|\bseo\b/.test(p)) return MARKETING[1]!;
  return MARKETING[seed % MARKETING.length]!;
}

export function generateLocalTemplateCopy(input: LocalTaskInput): unknown {
  const parsed = inputSchema.parse(input.message);
  const data = parsed.data;
  const copy = pick(data.category, data.utilityTrigger, data.purpose, input.seed);
  const firstName = FIRST_NAMES[input.seed % FIRST_NAMES.length]!;
  const exampleValues = copy.sources.map((s) => (s === 'lead.firstName' ? firstName : s === 'workspace.name' ? data.workspace.name.trim() || 'Our studio' : EXAMPLES[s]));
  return {
    name: `${copy.name}_${(input.seed % 900) + 100}`,
    headerText: copy.headerText,
    body: copy.body,
    footer: copy.footer,
    buttons: copy.buttons,
    exampleValues,
    variableSources: copy.sources,
  };
}
