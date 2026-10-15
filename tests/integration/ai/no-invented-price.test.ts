// AT5, C12, R17: an AI proposal can never set a price, a discount or tax.
// A LIVE workspace's Anthropic adapter (MockAgent, net disabled) returns a proposal whose item
// carries `unitPrice: 1` plus discount and tax keys. The draft:
// - keeps the item (service id and quantity) and drops every price/discount/tax key;
// - prices it from the server's active PricingVersion (unit price 8,500.00, configured tax);
// - is forced to review with aiPolicyFlags ai_price_ignored, ai_discount_ignored, ai_tax_ignored;
// - writes the `ai.proposal.flagged` AuditEvent with those flags next to `ai.draft.generate`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { withTx } from '@/server/db/tx';
import { generateLeadDraft, persistLeadDraft } from '@/server/services/ai/drafts';
import { computeQuoteTotals } from '@/server/services/pricing/compute-totals';
import { createMockTransport } from '../contract/support';
import { ANTHROPIC_KEY, createAiHarness, createLead, jobCtx, KEY_RING, makeLive, SERVICE, WS_A, type AiHarness } from './support';

let h: AiHarness;
let db: PrismaClient;

beforeAll(async () => {
  h = await createAiHarness('ai-no-invented-price');
  db = h.db;
  await makeLive(db, WS_A, { kind: 'AI_ANTHROPIC', apiKey: ANTHROPIC_KEY, modelId: 'claude-sonnet-5-5' });
});
afterAll(async () => {
  await h.testDb.destroy();
});

function anthropicReply(output: unknown) {
  return {
    id: 'msg_01AT5',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: JSON.stringify(output) }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 900, output_tokens: 200 },
  };
}

describe('AT5: AI proposal prices come only from the server', () => {
  it('unitPrice: 1 is ignored, flagged and audited; the server price is used', async () => {
    const lead = await createLead(db, WS_A);
    const t = createMockTransport('https://api.anthropic.com');
    t.reply(
      '/v1/messages',
      200,
      anthropicReply({
        templateVariables: ['Priya', 'Teeth whitening (in-clinic)'],
        followUp: 'Hi Priya, thanks for asking about teeth whitening. Shall we prepare a quotation?',
        email: { subject: 'Your teeth whitening enquiry', body: 'Hello Priya,\n\nWe can prepare a detailed quotation for you.\n\nRegards,\nSmile Avenue' },
        proposal: {
          items: [{ serviceId: SERVICE.WHITEN, qty: 2, unitPrice: 1, total: 2 }],
          scopeText: 'Two in-clinic whitening sessions.',
          timelineText: 'Two visits a week apart.',
          discountPercent: 50,
          taxBps: 0,
        },
      }),
    );

    const ctx = jobCtx(db, h.clock, 'live');
    const draft = await generateLeadDraft(ctx, { leadId: lead.id, trigger: 'MANUAL', requestedBy: 'user_test', finalAttempt: true }, { keyRing: KEY_RING, transport: { fetch: t.fetch } });
    const { id } = await withTx(db, (tx) => persistLeadDraft(tx, ctx, draft));
    await t.close();

    const row = await db.aiDraft.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('NEEDS_REVIEW');
    expect(row.generatorLabel).toBe('anthropic');
    expect(row.modelId).toBe('claude-sonnet-5-5');
    expect(row.escalated).toBe(true);
    expect(row.aiPolicyFlags).toEqual(['ai_discount_ignored', 'ai_price_ignored', 'ai_tax_ignored']);
    expect(row.proposal).toEqual({ items: [{ serviceId: SERVICE.WHITEN, qty: 2 }], scopeText: 'Two in-clinic whitening sessions.', timelineText: 'Two visits a week apart.' });
    expect(JSON.stringify(row.proposal)).not.toMatch(/unitPrice|discount|tax|total/i);

    // The preview equals the server's own computation for the same lines with no discount.
    const server = await computeQuoteTotals(ctx, { items: [{ serviceId: SERVICE.WHITEN, qty: 2 }], discount: { kind: 'NONE', value: 0n } });
    const preview = row.pricingPreview as { pricingVersionId: string; lines: Array<{ serviceId: string; qty: number; unitPricePaise: string; lineTotalPaise: string }>; discountPaise: string; taxPaise: string; totalPaise: string };
    expect(preview.pricingVersionId).toBe(server.pricingVersion.id);
    expect(preview.lines).toEqual([{ serviceId: SERVICE.WHITEN, serviceName: 'Teeth whitening (in-clinic)', qty: 2, unitPricePaise: '850000', lineTotalPaise: '1700000' }]);
    expect(preview.discountPaise).toBe('0');
    expect(preview.taxPaise).toBe(server.totals.taxPaise.toString());
    expect(preview.totalPaise).toBe(server.totals.totalPaise.toString());

    const flagged = await db.auditEvent.findFirstOrThrow({ where: { action: 'ai.proposal.flagged', targetId: id } });
    expect(flagged.summary).toMatchObject({ flags: ['ai_discount_ignored', 'ai_price_ignored', 'ai_tax_ignored'] });
    expect(flagged.workspaceId).toBe(WS_A);
    const generated = await db.auditEvent.findFirstOrThrow({ where: { action: 'ai.draft.generate', targetId: id } });
    expect(generated.summary).toMatchObject({ status: 'NEEDS_REVIEW', generatorLabel: 'anthropic', trigger: 'MANUAL' });
    expect(generated.correlationId).toBe(ctx.correlationId);
  });

  it('a clean proposal is READY and priced from the active version', async () => {
    const lead = await createLead(db, WS_A);
    const t = createMockTransport('https://api.anthropic.com');
    t.reply(
      '/v1/messages',
      200,
      anthropicReply({
        templateVariables: ['Priya', 'Root canal treatment'],
        followUp: 'Hi Priya, we can help with the root canal treatment you asked about. Would you like a quotation?',
        email: { subject: 'Root canal treatment enquiry', body: 'Hello Priya,\n\nWe can prepare a quotation for you.\n\nRegards,\nSmile Avenue' },
        proposal: { items: [{ serviceId: SERVICE.RCT, qty: 1 }, { serviceId: SERVICE.CONSULT, qty: 1 }], scopeText: 'Consultation, then a single-tooth root canal.', timelineText: 'About a week.' },
      }),
    );
    const ctx = jobCtx(db, h.clock, 'live');
    const draft = await generateLeadDraft(ctx, { leadId: lead.id, trigger: 'MANUAL', requestedBy: 'user_test', finalAttempt: true }, { keyRing: KEY_RING, transport: { fetch: t.fetch } });
    const { id } = await withTx(db, (tx) => persistLeadDraft(tx, ctx, draft));
    await t.close();

    const row = await db.aiDraft.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'READY', escalated: false, aiPolicyFlags: [], reviewReasons: [], policyViolations: [] });
    const preview = row.pricingPreview as { lines: Array<{ unitPricePaise: string }> };
    expect(preview.lines.map((l) => l.unitPricePaise)).toEqual(['650000', '80000']);
    expect(await db.auditEvent.count({ where: { action: 'ai.proposal.flagged', targetId: id } })).toBe(0);
  });
});
