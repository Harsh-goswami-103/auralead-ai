/**
 * Local generator for the `lead_draft` task (R16, C13, ADR-18), moved out of
 * ../local-deterministic.ts unchanged when that file became a dispatcher (lead-gen B2): same input
 * shape, same choices, byte-identical output.
 *
 * It reads the same JSON data block a provider would get and writes plain, policy-safe copy from
 * fixed templates. Every choice that is not fully determined by the lead (which matching service,
 * which phrasing) is keyed by the seed (the sha256 of the user message). It never writes amounts,
 * links, contacts or offers (the output policy would escalate them), and it proposes only catalog
 * services at their minimum quantity.
 */
import { z } from 'zod';
import type { LocalTaskInput } from '../local-deterministic';

const inputSchema = z.object({
  data: z.object({
    workspace: z.object({ name: z.string() }),
    lead: z.object({ displayName: z.string().nullable(), category: z.string().nullable() }).loose(),
    catalog: z.array(
      z.object({
        serviceId: z.string(),
        name: z.string(),
        description: z.string(),
        unitLabel: z.string(),
        minQty: z.number().int(),
        maxQty: z.number().int(),
        typicalTimelineDays: z.number().int().nullable(),
      }),
    ),
    template: z.object({ variableCount: z.number().int().min(0).max(10) }),
  }).loose(),
});

type Service = z.infer<typeof inputSchema>['data']['catalog'][number];

const words = (s: string | null | undefined) =>
  new Set(
    (s ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4),
  );

/** First name: the first word of the display name, letters only; empty when none survives. */
function firstName(displayName: string | null): string {
  const first = (displayName ?? '').trim().split(/\s+/)[0] ?? '';
  return first.replace(/[^\p{L}'-]/gu, '').slice(0, 40);
}

function pickService(catalog: readonly Service[], category: string | null, seed: number): Service | null {
  if (catalog.length === 0) return null;
  const want = words(category);
  let best: Service[] = [];
  let bestScore = 0;
  for (const s of catalog) {
    const have = words(`${s.name} ${s.description}`);
    let score = 0;
    for (const w of want) if (have.has(w)) score += 1;
    if (score > bestScore) {
      best = [s];
      bestScore = score;
    } else if (score === bestScore && score > 0) {
      best.push(s);
    }
  }
  const pool = bestScore > 0 ? best : catalog;
  return pool[seed % pool.length] ?? null;
}

function timelinePhrase(days: number | null): string {
  if (days === null) return 'We will confirm the timeline with you when we prepare the quotation.';
  if (days <= 1) return 'Usually completed within a day.';
  if (days < 14) return `Usually completed within ${days} days.`;
  const weeks = Math.round(days / 7);
  if (days < 60) return `Usually completed within about ${weeks} weeks.`;
  return `Usually completed within about ${Math.round(days / 30)} months.`;
}

const OPENERS = ['Thanks for your interest in', 'Thank you for asking about', 'Good to hear you are looking into'] as const;

export type LocalDraftOutput = {
  templateVariables: string[];
  followUp: string;
  email: { subject: string; body: string };
  proposal: { items: Array<{ serviceId: string; qty: number }>; scopeText: string; timelineText: string };
};

export function generateLocalDraft({ message, seed }: LocalTaskInput): LocalDraftOutput {
  const parsed = inputSchema.safeParse(message);
  if (!parsed.success) {
    // The context builder always produces this shape; anything else is a programming error.
    throw new TypeError('local-deterministic generator: unexpected input shape');
  }
  const { workspace, lead, catalog, template } = parsed.data.data;
  const name = firstName(lead.displayName);
  const greeting = name ? `Hi ${name}` : 'Hello';
  const service = pickService(catalog, lead.category, seed);
  const topic = service ? service.name : 'our services';
  const opener = OPENERS[seed % OPENERS.length]!;

  const vars: string[] = [];
  for (let i = 0; i < template.variableCount; i++) vars.push(i === 0 ? name || 'there' : topic);

  return {
    templateVariables: vars,
    followUp: `${greeting}, ${opener.charAt(0).toLowerCase()}${opener.slice(1)} ${topic} at ${workspace.name}. Would you like us to prepare a detailed quotation? Reply here and our team will get back to you.`,
    email: {
      subject: `Your enquiry about ${topic}`,
      body: `${greeting},\n\n${opener} ${topic}. We would be happy to prepare a detailed quotation for you, covering the scope and timeline.\n\nJust reply to this email with any questions or details you would like us to include.\n\nRegards,\n${workspace.name}`,
    },
    proposal: service
      ? {
          items: [{ serviceId: service.serviceId, qty: Math.max(1, service.minQty) }],
          scopeText: `${service.name}: ${service.description}`.slice(0, 1000),
          timelineText: timelinePhrase(service.typicalTimelineDays),
        }
      : { items: [], scopeText: '', timelineText: '' },
  };
}
