// ADR-123 (slice F4), "Generate with AI" in LIVE against the real Anthropic adapter on an undici
// MockAgent (net connect disabled; documented-shape, not live-verified):
// - The request carries the person's category, language, UTILITY trigger and purpose and the
//   catalog's names and descriptions inside the JSON data block, never a price, and asks for the
//   structured output of the task (every property required, no extra properties).
// - A valid answer becomes a draft that keeps the person's category and trigger, labelled with the
//   provider; MARKETING gets the Stop quick reply added; nothing is stored.
// - A policy violation (a price, UTILITY promotion) gets exactly one repair call that names it;
//   a second violation fails (AI_MALFORMED_OUTPUT) and the person writes the template themselves.
// - A provider failure (401) never falls back to the local generator.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { generateTemplateCopy } from '@/server/services/ai/template-copy';
import { createMockTransport, fixture } from '../contract/support';
import { ANTHROPIC_KEY, createAiHarness, KEY_RING, makeLive, ownerCtx, WS_A, type AiHarness } from '../ai/support';

let h: AiHarness;
let db: PrismaClient;
let t: ReturnType<typeof createMockTransport>;

beforeAll(async () => {
  h = await createAiHarness('f4-template-copy-live');
  db = h.db;
}, 120_000);
afterAll(async () => h?.testDb.destroy());
beforeEach(async () => {
  await t?.close();
  t = createMockTransport('https://api.anthropic.com');
  await makeLive(db, WS_A, { kind: 'AI_ANTHROPIC', apiKey: ANTHROPIC_KEY, modelId: 'claude-sonnet-5-5' });
});

const deps = () => ({ keyRing: KEY_RING, transport: { fetch: t.fetch, timeoutMs: 2_000 } });
const ctx = () => ownerCtx(db, h.clock, 'live');

/** An Anthropic answer whose text is the task's JSON output. */
function answer(output: unknown) {
  return { ...(fixture('anthropic', 'success') as object), content: [{ type: 'text', text: JSON.stringify(output) }] };
}

const VALID_UTILITY = {
  name: 'meeting_confirmed',
  headerText: 'Meeting confirmed',
  body: 'Hello {{1}}, your meeting with {{2}} is confirmed. Reply here if you need to change the time.',
  footer: null,
  buttons: ['Change the time'],
  exampleValues: ['Ravi', 'Smile Avenue Dental'],
  variableSources: ['lead.firstName', 'workspace.name'],
};

/** The JSON data block the model was sent. */
function sentData(index = 0): Record<string, unknown> {
  const messages = t.captured[index]!.body.messages as Array<{ content: string }>;
  return (JSON.parse(messages[0]!.content) as { data: Record<string, unknown> }).data;
}

describe('template_copy through the Anthropic adapter', () => {
  it('sends the person’s choices and the catalog without prices, and keeps the person’s category', async () => {
    t.reply('/v1/messages', 200, answer(VALID_UTILITY));
    const before = await db.whatsAppTemplate.count();
    const result = await generateTemplateCopy(ctx(), { category: 'UTILITY', language: 'en', utilityTrigger: 'MEETING_BOOKED', purpose: 'Confirm the booked meeting' }, deps());

    expect(result).toMatchObject({ generatorLabel: 'anthropic', modelId: expect.any(String), draft: { category: 'UTILITY', utilityTrigger: 'MEETING_BOOKED', language: 'en', name: 'meeting_confirmed', header: { format: 'TEXT', text: 'Meeting confirmed' } } });
    expect(result.draft.variables).toEqual([
      { position: '1', source: 'lead.firstName', example: 'Ravi' },
      { position: '2', source: 'workspace.name', example: 'Smile Avenue Dental' },
    ]);
    expect(result.draft.buttons).toEqual([{ type: 'QUICK_REPLY', text: 'Change the time', intent: null }]);
    expect(result.warnings.filter((w) => w.code === 'PROMOTIONAL_WORDS')).toEqual([]);

    expect(t.captured).toHaveLength(1);
    const data = sentData();
    expect(data).toMatchObject({ category: 'UTILITY', language: 'en', utilityTrigger: 'MEETING_BOOKED', purpose: 'Confirm the booked meeting', workspace: { name: 'Smile Avenue Dental Clinic' } });
    const catalog = data.catalog as Array<Record<string, unknown>>;
    expect(catalog.length).toBeGreaterThan(0);
    for (const entry of catalog) expect(Object.keys(entry).sort()).toEqual(['description', 'name']);
    expect(t.captured[0]!.headers['x-api-key']).toBe(ANTHROPIC_KEY);

    const format = (t.captured[0]!.body.output_config as { format: { type: string; schema: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } } }).format;
    expect(format.type).toBe('json_schema');
    expect(format.schema.additionalProperties).toBe(false);
    expect([...format.schema.required].sort()).toEqual(Object.keys(format.schema.properties).sort());
    expect(await db.whatsAppTemplate.count()).toBe(before);
  });

  it('MARKETING copy gets the Stop quick reply added to the model’s buttons', async () => {
    t.reply('/v1/messages', 200, answer({ ...VALID_UTILITY, name: 'website_intro', headerText: null, body: 'Hello {{1}}, {{2}} builds fast websites for local businesses. Would you like to see our work?', footer: 'Tap Stop to opt out', buttons: ['See our work'] }));
    const result = await generateTemplateCopy(ctx(), { category: 'MARKETING', language: 'en', utilityTrigger: null, purpose: '' }, deps());
    expect(result.draft).toMatchObject({ category: 'MARKETING', utilityTrigger: null, header: { format: 'NONE' } });
    expect(result.draft.buttons).toEqual([
      { type: 'QUICK_REPLY', text: 'Stop', intent: 'STOP' },
      { type: 'QUICK_REPLY', text: 'See our work', intent: null },
    ]);
    expect(sentData()).toMatchObject({ category: 'MARKETING', utilityTrigger: null });
  });

  it('a price or UTILITY promotion gets one repair call naming it, then the valid copy', async () => {
    t.reply('/v1/messages', 200, answer({ ...VALID_UTILITY, body: 'Hello {{1}}, your meeting with {{2}} is confirmed for just Rs 500. Reply here to change it.' }));
    t.reply('/v1/messages', 200, answer(VALID_UTILITY));
    const result = await generateTemplateCopy(ctx(), { category: 'UTILITY', language: 'en', utilityTrigger: 'MEETING_BOOKED', purpose: '' }, deps());
    expect(result.draft.body).toBe(VALID_UTILITY.body);
    expect(t.captured).toHaveLength(2);
    const roles = (t.captured[1]!.body.messages as Array<{ role: string; content: string }>).map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(t.captured[1]!.body.messages)).toContain('a price or amount');
  });

  it('two violations fail with AI_MALFORMED_OUTPUT: no third call, nothing stored', async () => {
    const promo = { ...VALID_UTILITY, body: 'Hello {{1}}, our free brochure from {{2}} is ready. Reply here to get it.' };
    t.reply('/v1/messages', 200, answer(promo));
    t.reply('/v1/messages', 200, answer(promo));
    await expect(generateTemplateCopy(ctx(), { category: 'UTILITY', language: 'en', utilityTrigger: 'CUSTOMER_ASKED', purpose: '' }, deps())).rejects.toMatchObject({ code: 'AI_MALFORMED_OUTPUT' });
    expect(t.captured).toHaveLength(2);
  });

  it('a provider failure never falls back to the local generator', async () => {
    t.reply('/v1/messages', 401, fixture('anthropic', 'error-401'));
    await expect(generateTemplateCopy(ctx(), { category: 'MARKETING', language: 'en', utilityTrigger: null, purpose: '' }, deps())).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
    expect(t.captured).toHaveLength(1);
  });
});
