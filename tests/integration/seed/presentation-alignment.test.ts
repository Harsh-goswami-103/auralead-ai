/**
 * Cross-slice alignment of the presentation pack (integrator). Slice F6 seeded rows by hand while
 * F3, F4 and F5 wrote the services that produce the same rows in the product. Each test here
 * recomputes a seeded row through the real production function of the owning slice, so the pack
 * can never show something the product itself would not write:
 *  - F3: the seeded catalog answers are what `buildConversationReplyPrompt` + the local generator
 *    write for the same catalog and thread;
 *  - F4: the seeded authored templates are valid drafts of the template studio, with a UTILITY
 *    trigger the studio offers;
 *  - F5: the recorded opt-ins carry what `grantManualConsent` stores (method, notice verbatim and
 *    its hash), and the handoff row, summary JSON and audit are what `handOverLead` writes, readable
 *    by the client panel.
 * Also pinned: the pack's finder results outlive the 24-hour rule of real runs (ADR-134).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { UTILITY_TRIGGERS, checkTemplateDraft, draftFromStored } from '@/lib/domain/template-authoring';
import { OPT_IN_METHODS } from '@/lib/schemas/consent';
import { HandoffSummaryContent, parseStoredHandoffSummary } from '@/lib/schemas/handoff';
import { noticeNamesBusiness } from '@/lib/schemas/reach-out';
import { createLocalDeterministicAdapter } from '@/server/adapters/ai/local-deterministic';
import { generateLocalHandoffSummary } from '@/server/adapters/ai/local/handoff-summary';
import { getWebhookContext } from '@/server/auth/context';
import { buildConversationReplyPrompt } from '@/server/services/ai/conversation-reply';
import { buildHandoffSummaryPrompt, loadHandoffSummaryContext } from '@/server/services/ai/handoff-summary';
import { loadReplyFacts } from '@/server/services/ai/reply-guard';
import { noticeTextHash } from '@/server/services/messaging/consent';
import { seedId } from '../../../prisma/seed/ids';
import { AUTOMATED_DISCLOSURE, HANDOFF_FIXTURE, PRESENTATION_OPT_IN_NOTICE, PRESENTATION_SLUG } from '../../../prisma/seed/fixtures/presentation';
import { seedDemo } from '../../../prisma/seed/seed';
import { createTestDb, type TestDb } from '../../support/db';

const T0 = new Date('2026-10-15T04:30:00.000Z');
const DAY = 24 * 3_600_000;
const PEPPER = `presentation-seed-pepper-${'p'.repeat(32)}`;
const CONFIG = { mode: 'demo' as const, secrets: { suppressionPepper: PEPPER } };
const WS = seedId('workspace', PRESENTATION_SLUG);
const leadIdOf = (place: string) => seedId('lead', `${PRESENTATION_SLUG}:${place}`);

let testDb: TestDb;
let db: PrismaClient;

beforeAll(async () => {
  testDb = await createTestDb({ label: 'seed-presentation-alignment' });
  db = testDb.client();
  await seedDemo(db, { config: CONFIG, now: T0 });
}, 120_000);
afterAll(async () => {
  await testDb?.destroy();
});

const ctx = () => getWebhookContext({ workspaceId: WS }, { prisma: db, mode: 'demo', clock: new FixedClock(T0) }, 'req_presentation_alignment');

describe('F3: the seeded catalog answers are what the local conversation_reply generator writes', () => {
  it('recomputes every local-deterministic reply through the production prompt builder and the local adapter', async () => {
    const facts = await loadReplyFacts(ctx().db, WS);
    const adapter = createLocalDeterministicAdapter();
    const conversations = await db.conversation.findMany({ where: { workspaceId: WS }, include: { messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } });
    let checked = 0;
    for (const c of conversations) {
      for (const m of c.messages) {
        if (m.direction !== 'OUT' || m.generatorLabel !== 'local-deterministic') continue;
        const inbound = c.messages.find((x) => x.id === m.replyToInboundId)!;
        // The thread the live path hands the generator: sent or received text up to the inbound message (loadHistory).
        const history = c.messages
          .filter((x) => x.createdAt <= inbound.createdAt && (x.body ?? '').trim() !== '' && (x.kind === 'TEXT' || x.kind === 'TEMPLATE'))
          .slice(-12)
          .map((x) => ({ from: x.direction === 'IN' ? ('customer' as const) : ('business' as const), text: x.body! }));
        const prompt = buildConversationReplyPrompt(facts, history);
        const generated = await adapter.generate({ system: prompt.system, user: prompt.user, jsonSchema: prompt.jsonSchema, maxTokens: 1200 } as never);
        const out = JSON.parse(generated.text) as { reply: string; intent: string; escalate: boolean };
        expect(out).toMatchObject({ intent: 'service_faq', escalate: false });
        const stored = m.body!.startsWith(`${AUTOMATED_DISCLOSURE}\n\n`) ? m.body!.slice(`${AUTOMATED_DISCLOSURE}\n\n`.length) : m.body!;
        expect(stored, `seeded reply ${m.id}: copy the generator's text into ANSWER_* in prisma/seed/fixtures/presentation.ts`).toBe(out.reply);
        checked += 1;
      }
    }
    expect(checked).toBe(2);
  });
});

describe('F4: the seeded authored templates are valid studio drafts', () => {
  it('round-trips each template through the studio and offers a UTILITY trigger the studio knows', async () => {
    const rows = await db.whatsAppTemplate.findMany({ where: { workspaceId: WS } });
    expect(rows.map((r) => r.name).sort()).toEqual(['brochure_share', 'discount_blast', 'follow_up', 'meeting_confirm', 'website_intro']);
    for (const row of rows) {
      expect(row.origin, row.name).toBe('AUTHORED');
      const draft = draftFromStored(row);
      const check = checkTemplateDraft(draft, { forSubmit: false });
      expect(check.errors, `${row.name}: ${JSON.stringify(check.errors)}`).toEqual([]);
      if (row.category === 'UTILITY') {
        expect(UTILITY_TRIGGERS as readonly string[]).toContain(row.utilityTrigger);
        expect(draft.utilityTrigger).toBe(row.utilityTrigger);
      } else {
        expect(row.utilityTrigger).toBeNull();
        // MARKETING templates carry the STOP quick reply the studio adds by default (mapped to the STOP payload).
        // The rejected one is the story's counter-example: its simulated rejection reason is that it gives no way to opt out.
        const hasStop = draft.buttons.some((b) => b.type === 'QUICK_REPLY' && b.intent === 'STOP');
        expect(hasStop, `${row.name} ${row.status}`).toBe(row.status !== 'REJECTED');
      }
    }
  });
});

describe('F5: recorded opt-ins and the handoff look like the ones the services write', () => {
  it('stores each opt-in with its method, the notice verbatim (naming the business) and the notice hash', async () => {
    const optIns = await db.consentRecord.findMany({ where: { workspaceId: WS, basis: 'OPT_IN' } });
    expect(optIns).toHaveLength(3);
    for (const c of optIns) {
      const evidence = c.evidence as { method?: string; note?: string; noticeText?: string };
      expect(OPT_IN_METHODS as readonly string[]).toContain(evidence.method);
      expect(evidence.noticeText).toBe(PRESENTATION_OPT_IN_NOTICE);
      expect(noticeNamesBusiness(evidence.noticeText!, 'Codecraft Web Studio')).toBe(true);
      expect(c.noticeTextHash).toBe(noticeTextHash(evidence.noticeText!));
      const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'consent.grant', targetId: c.id } });
      expect(audit.summary).toMatchObject({ channel: 'WHATSAPP', purpose: 'MARKETING', basis: 'OPT_IN', source: 'MANUAL_EVIDENCE', method: evidence.method, fields: ['evidence.note', 'evidence.method', 'noticeText'] });
    }
  });

  it('stores the handoff summary as the JSON the client panel reads, equal to what the local generator writes for the thread', async () => {
    const leadId = leadIdOf(HANDOFF_FIXTURE.place);
    const handoff = await db.leadHandoff.findUniqueOrThrow({ where: { workspaceId_leadId: { workspaceId: WS, leadId } } });
    const parsed = parseStoredHandoffSummary(handoff.summary);
    expect(parsed, 'LeadHandoff.summary must be the JSON {asked, promised, nextStep}').not.toBeNull();
    expect(HandoffSummaryContent.safeParse(parsed).success).toBe(true);

    // Recompute through the production path: the summary context of a PENDING handoff, the prompt, the local generator.
    await db.leadHandoff.update({ where: { id: handoff.id }, data: { summaryStatus: 'PENDING' } });
    try {
      const loaded = (await loadHandoffSummaryContext(ctx(), handoff.id))!;
      const message = JSON.parse(buildHandoffSummaryPrompt(loaded.data).user) as unknown;
      // The opener depends on a hash of the thread's timestamps (seed % 2): both wordings are the generator's.
      const candidates = [0, 1].map((seed) => generateLocalHandoffSummary({ message, seed }));
      expect(candidates, JSON.stringify(parsed)).toContainEqual(parsed);
    } finally {
      await db.leadHandoff.update({ where: { id: handoff.id }, data: { summaryStatus: 'READY' } });
    }
    expect(HANDOFF_FIXTURE.summary).toEqual(parsed);
  });

  it('audits the handoff with the keys handOverLead writes, never the note, and the summary with the keys persistHandoffSummary writes', async () => {
    const leadId = leadIdOf(HANDOFF_FIXTURE.place);
    const handoff = await db.leadHandoff.findUniqueOrThrow({ where: { workspaceId_leadId: { workspaceId: WS, leadId } } });
    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'lead.handoff', targetId: leadId } });
    expect(Object.keys(audit.summary as object).sort()).toEqual(
      ['cancelledSends', 'conversationIds', 'conversations', 'from', 'handoffId', 'hasNote', 'invalidatedApprovals', 'pipelineHalted', 'requestKey', 'stageVersion', 'summaryJobId', 'summaryStatus', 'to'].sort(),
    );
    expect(audit.summary).toMatchObject({ handoffId: handoff.id, to: 'CONVERTED', stageVersion: lead.stageVersion, hasNote: true, requestKey: HANDOFF_FIXTURE.requestKey, conversations: 1 });
    expect(JSON.stringify(audit.summary)).not.toContain(HANDOFF_FIXTURE.note);
    const summaryAudit = await db.auditEvent.findFirstOrThrow({ where: { action: 'lead.handoff.summary', targetId: leadId } });
    expect(Object.keys(summaryAudit.summary as object).sort()).toEqual(['errorCode', 'fields', 'generatorLabel', 'handoffId', 'modelId', 'status', 'violationRules']);
    expect(summaryAudit.summary).toMatchObject({ handoffId: handoff.id, status: 'READY', generatorLabel: 'local-deterministic', fields: ['summary'] });
  });
});

describe('ADR-134: the pack outlives the 24-hour rule', () => {
  it('keeps the seeded finder results and the Places leads readable for the presentation', async () => {
    const results = await db.leadFinderResult.findMany({ where: { workspaceId: WS } });
    expect(results).toHaveLength(40);
    // A year after the fetch, not 24 hours: whenever the presenter opens the page the details are there.
    for (const r of results) expect(r.contentExpiresAt!.getTime() - r.createdAt.getTime()).toBe(365 * DAY);
    // No purge job is queued for the seeded run, so nothing nulls the content behind the presenter.
    expect(await db.job.count({ where: { workspaceId: WS, type: { in: ['leadFinder.purge', 'leads.placesExpire'] } } })).toBe(0);
  });
});
