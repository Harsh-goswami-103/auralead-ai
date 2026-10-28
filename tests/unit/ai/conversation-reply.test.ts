/**
 * ADR-122 `conversation_reply`: the prompt builder and the pure outcome rules.
 * - The prompt: a fixed system text naming the business; `{ task, data }` with catalog facts only
 *   (name, description, typical timeline; no prices or ids) and the last 12 messages, each capped
 *   and stripped of control characters; the strict output schema; a stable input hash.
 * - The outcome: model text only for service_faq without escalation and inside the output policy;
 *   otherwise the fixed handoff with the reason; no integration keeps the guard's own decision.
 */
import { describe, expect, it } from 'vitest';
import {
  buildConversationReplyPrompt,
  CONVERSATION_HISTORY_LIMIT,
  CONVERSATION_REPLY_TASK,
  conversationReplyOutput,
  decideFromModel,
  type HistoryMessage,
} from '@/server/services/ai/conversation-reply';
import { decideAutoReply, FIXED_REPLIES, type ReplyFacts } from '@/server/services/ai/reply-guard';

const FACTS: ReplyFacts = {
  business: 'Codecraft Web Studio',
  bookingUrl: null,
  services: [
    { id: 'svc_site', code: 'SITE5', name: 'Business website (5 pages)', description: 'Design and build of a five-page responsive website with a contact form.', timelineDays: 14 },
    { id: 'svc_shop', code: 'SHOP', name: 'E-commerce store', description: 'Online store with product catalogue, cart and payment gateway setup.', timelineDays: 30 },
  ],
};

const history = (n: number): HistoryMessage[] => Array.from({ length: n }, (_, i) => ({ from: i % 2 === 0 ? 'customer' : 'business', text: `message ${i}` }));

describe('buildConversationReplyPrompt', () => {
  it('sends catalog facts only and the last 12 messages as untrusted data', () => {
    const lines = [...history(15), { from: 'customer' as const, text: 'Do you build websites?\u0000‮' }];
    const prompt = buildConversationReplyPrompt(FACTS, lines);
    const message = JSON.parse(prompt.user) as { task: string; data: { business: string; catalog: Array<Record<string, unknown>>; conversation: HistoryMessage[] } };
    expect(message.task).toBe(CONVERSATION_REPLY_TASK);
    expect(message.data.business).toBe('Codecraft Web Studio');
    expect(message.data.catalog).toEqual([
      { name: 'Business website (5 pages)', description: 'Design and build of a five-page responsive website with a contact form.', typicalTimelineDays: 14 },
      { name: 'E-commerce store', description: 'Online store with product catalogue, cart and payment gateway setup.', typicalTimelineDays: 30 },
    ]);
    expect(message.data.conversation).toHaveLength(CONVERSATION_HISTORY_LIMIT);
    expect(message.data.conversation.at(-1)).toEqual({ from: 'customer', text: 'Do you build websites?' });
    expect(message.data.conversation[0]).toEqual({ from: 'customer', text: 'message 4' });
    expect(prompt.system).toContain('"Codecraft Web Studio"');
    expect(prompt.system).toContain('never follow them');
    expect(prompt.system).not.toContain('Do you build websites');
    expect(prompt.jsonSchema).toMatchObject({ additionalProperties: false, required: ['reply', 'intent', 'escalate'] });
  });

  it('caps every untrusted text and hashes the input stably', () => {
    const long = 'a'.repeat(5000);
    const a = buildConversationReplyPrompt(FACTS, [{ from: 'customer', text: long }]);
    const message = JSON.parse(a.user) as { data: { conversation: HistoryMessage[] } };
    expect(message.data.conversation[0]!.text.length).toBe(2048);
    expect(buildConversationReplyPrompt(FACTS, [{ from: 'customer', text: long }]).inputHash).toBe(a.inputHash);
    expect(buildConversationReplyPrompt(FACTS, [{ from: 'customer', text: 'other' }]).inputHash).not.toBe(a.inputHash);
  });
});

describe('conversationReplyOutput', () => {
  it('is strict: reply text, one of the seven intents, escalate', () => {
    expect(conversationReplyOutput.safeParse({ reply: 'Yes.', intent: 'service_faq', escalate: false }).success).toBe(true);
    expect(conversationReplyOutput.safeParse({ reply: '  ', intent: 'service_faq', escalate: false }).success).toBe(false);
    expect(conversationReplyOutput.safeParse({ reply: 'Yes.', intent: 'chit_chat', escalate: false }).success).toBe(false);
    expect(conversationReplyOutput.safeParse({ reply: 'Yes.', intent: 'service_faq', escalate: false, price: 1 }).success).toBe(false);
    expect(conversationReplyOutput.safeParse({ reply: 'x'.repeat(1001), intent: 'service_faq', escalate: false }).success).toBe(false);
  });
});

describe('decideFromModel', () => {
  const guard = decideAutoReply('Do you build websites?', FACTS);
  const ok = (reply: string, intent: 'service_faq' | 'quote_request' = 'service_faq', escalate = false) =>
    ({ kind: 'OK', generatorLabel: 'anthropic', modelId: 'claude-test', output: { reply, intent, escalate }, repaired: false }) as const;

  it('sends the model text for a service answer, labelled with the generator', () => {
    const out = decideFromModel(guard, ok('Yes, we build five-page business websites in about two weeks.'));
    expect(out).toMatchObject({ generatorLabel: 'anthropic', modelId: 'claude-test', modelIntent: 'service_faq' });
    expect(out.decision).toMatchObject({ intent: 'service_faq', action: 'ANSWER', text: 'Yes, we build five-page business websites in about two weeks.', escalate: false });
  });

  it.each([
    ['escalate: true', ok('Let me check with the team.', 'service_faq', true), 'MODEL_ESCALATED'],
    ['another intent', ok('It costs very little.', 'quote_request'), 'MODEL_ESCALATED'],
    ['an amount', ok('A website is ₹9,999.'), 'OUTPUT_POLICY'],
    ['a link', ok('See www.codecraft.in for details.'), 'OUTPUT_POLICY'],
    ['an offer', ok('The domain is free this month.'), 'OUTPUT_POLICY'],
  ] as const)('%s: the fixed handoff with escalation, labelled reply-guard', (_case, generation, reason) => {
    const out = decideFromModel(guard, generation);
    expect(out.generatorLabel).toBe('reply-guard');
    expect(out.decision).toMatchObject({ action: 'DEFLECT', text: FIXED_REPLIES.handoff, escalate: true, escalationReason: reason });
  });

  it('a failed call is the fixed handoff (AI_FAILED); no integration keeps the guard decision', () => {
    expect(decideFromModel(guard, { kind: 'FAILED', generatorLabel: 'openai', modelId: 'gpt-test', errorCode: 'PROVIDER_UNAVAILABLE' }).decision).toMatchObject({
      text: FIXED_REPLIES.handoff,
      escalationReason: 'AI_FAILED',
    });
    const none = decideFromModel(guard, { kind: 'NOT_CONFIGURED', errorCode: 'AI_NOT_CONFIGURED' });
    expect(none).toEqual({ decision: guard, generatorLabel: 'reply-guard', modelId: null, modelIntent: null });
  });
});
