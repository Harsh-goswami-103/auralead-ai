// Cross-slice (integrator): the DEMO story of the presentation, end to end in one test, in the
// presentation workspace (codecraft-web, ADR-126) with its two personas (the operator and the
// client), the production handlers and the production DEMO transport:
//   find (F1: a simulated finder run) -> import three results as leads -> record a WhatsApp opt-in
//   for one (F5) -> author, submit and approve a template (F4: Generate with AI, the simulated
//   review) -> send it in bulk (the opted-in lead is queued, the other two are skipped
//   NO_WHATSAPP_OPT_IN) -> the customer replies (the DEMO inbound simulation, F3) -> Automatic
//   replies: the AI answers a service question in AUTO with the labelled local generator and the
//   delivered and read ticks follow -> hand over to the client (F5: the AI stops, the operator is
//   read-only, the summary is written) -> the client acknowledges and carries on.
// DEMO makes zero outbound calls: a socket, TLS, DNS or fetch tripwire, the outbound-attempt log and
// the scripted provider stand-in all stay empty; every send lands in the demo outbox, simulated.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@/lib/logger';
import { outboundAttempts, resetOutboundAttempts } from '@/server/adapters/http/outbound';
import { demoOutboxDir, readDemoOutbox } from '@/server/adapters/whatsapp/demo';
import type { AppCtx } from '@/server/auth/context';
import { createBulkRunJob } from '@/server/jobs/handlers/bulk-run';
import { createDispatchWhatsAppJob } from '@/server/jobs/handlers/dispatch-whatsapp';
import { createHandoffSummaryJob } from '@/server/jobs/handlers/handoff-summary';
import { createLeadFinderEmailsJob } from '@/server/jobs/handlers/lead-finder-emails';
import { createLeadFinderPurgeJob } from '@/server/jobs/handlers/lead-finder-purge';
import { createLeadFinderSearchJob } from '@/server/jobs/handlers/lead-finder-search';
import { createReplyAutoJob } from '@/server/jobs/handlers/reply-auto';
import { createStatusApplyJob } from '@/server/jobs/handlers/status-apply';
import { createTemplateReviewJob } from '@/server/jobs/handlers/template-review';
import { createTemplateSubmitJob } from '@/server/jobs/handlers/template-submit';
import { createWaDemoStatusJob, DEMO_DELIVERED_AFTER_MS, DEMO_READ_AFTER_MS } from '@/server/jobs/handlers/wa-demo-status';
import { createWebhookProcessJob } from '@/server/jobs/handlers/webhook-process';
import { buildJobRegistry } from '@/server/jobs/registry';
import { automatedReplyDisclosure } from '@/server/services/ai/reply-guard';
import { generateTemplateCopy } from '@/server/services/ai/template-copy';
import { getBulkRun, previewBulkAction, requestBulkRun } from '@/server/services/bulk/bulk';
import { createTemplateDraft, submitTemplate } from '@/server/services/integrations/template-authoring';
import { importFinderResults } from '@/server/services/lead-finder/import';
import { startFinderRun } from '@/server/services/lead-finder/runs';
import { StartFinderRunBody } from '@/server/services/lead-finder/schemas';
import { acknowledgeHandoff, handOverLead, listClientHandoffs, loadLeadHandoff } from '@/server/services/leads/handoff';
import { loadClientCommandCenter } from '@/server/services/metrics/command-center';
import { getWorkspaceAutoSend, setConversationAiMode } from '@/server/services/messaging/conversations';
import { grantManualConsent } from '@/server/services/messaging/consent';
import { getInboxThread, listInboxThreads, sendComposerMessage } from '@/server/services/messaging/inbox';
import { simulateWhatsAppInbound } from '@/server/services/messaging/inbound';
import { createWorker } from '../../../worker/worker';
import { DEMO_AI, requestKey } from '../handoff/support';
import { createInboundHarness, PEPPER, type InboundHarness } from '../messaging/inbound-support';
import { userCtx } from '../quotes/support';
import { armOutboundTripwire, newTripwireCounters, tripwireArmed } from '../../support/tripwire';

const SLUG = 'codecraft-web';
const BUSINESS = 'Codecraft Web Studio';
const DEPS = { contactKeyPepper: PEPPER, externalOutboundPause: false };
const NOTICE = `Yes, I agree to receive WhatsApp messages from ${BUSINESS} about website services. Reply STOP to stop them.`;

let h: InboundHarness;
let operator: AppCtx;
let client: AppCtx;
let drain: () => Promise<number>;
const tripwire = newTripwireCounters();

beforeAll(async () => {
  h = await createInboundHarness('lg-demo-story');
  operator = await userCtx(h.db, h.clock, 'employee', SLUG);
  client = await userCtx(h.db, h.clock, 'client');
  // The production handlers and the production DEMO transport. The harness's own worker, with its
  // scripted provider stand-in, is never drained by this file: its record stays empty.
  const worker = createWorker(
    {
      db: h.db,
      clock: h.clock,
      registry: buildJobRegistry([
        createLeadFinderSearchJob({ mode: () => 'demo', deps: () => ({ keyRing: null }) }),
        createLeadFinderPurgeJob({ mode: () => 'demo' }),
        createLeadFinderEmailsJob({ mode: () => 'demo' }),
        createTemplateSubmitJob({ deps: () => ({ keyRing: null, graphVersion: null, storageDir: h.storageDir, mode: 'demo' }) }),
        createTemplateReviewJob({ mode: () => 'demo' }),
        createBulkRunJob({ deps: () => ({ contactKeyPepper: PEPPER }), mode: () => 'demo' }),
        createWebhookProcessJob({ deps: () => h.inboundDeps }),
        createStatusApplyJob({ deps: () => h.inboundDeps }),
        createReplyAutoJob({ mode: () => 'demo', deps: () => ({ contactKeyPepper: PEPPER, ai: { keyRing: null } }) }),
        createDispatchWhatsAppJob({ mode: () => 'demo', deps: h.runtimeDeps }),
        createWaDemoStatusJob({ mode: () => 'demo', deps: () => ({ ...h.inboundDeps, journalDir: h.config.paths.journalDir }) }),
        createHandoffSummaryJob({ mode: () => 'demo', deps: () => DEMO_AI }),
      ]),
      logger: createLogger({ level: 'silent' }),
      mode: 'demo',
      version: 'test',
      random: () => 0,
    },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
  drain = async () => {
    let ran = 0;
    while ((await worker.tick()) === 'ran') ran += 1;
    return ran;
  };
}, 120_000);

// Armed before every test: restoreMocks (vitest config) restores spies before each test, so a spy set in beforeAll would be gone.
beforeEach(() => armOutboundTripwire(tripwire));
afterAll(async () => {
  vi.restoreAllMocks();
  await h?.destroy();
});

const receiveDeps = () => ({ ...h.inboundDeps, journalDir: h.config.paths.journalDir });

describe('the DEMO story: find, import, opt in, template, chat, hand over, acknowledge', () => {
  it('runs end to end with zero outbound calls', async () => {
    expect(tripwireArmed(), 'the wire tripwire is armed for this test').toBe(true);
    resetOutboundAttempts();
    const workspace = await h.db.workspace.findUniqueOrThrow({ where: { slug: SLUG } });
    const whatsapp = await h.db.integration.findFirstOrThrow({ where: { workspaceId: workspace.id, kind: 'WHATSAPP_CLOUD' } });
    expect(whatsapp.status).toBe('SIMULATED');

    // ---- 1. Find: a simulated finder run for businesses without a website ---------------------
    const { run } = await startFinderRun(operator, StartFinderRunBody.parse({ requestKey: 'story-run-0001', keywords: ['Dental clinic'], locations: ['Indore'], maxPerQuery: 20 }), { keyRing: null });
    expect(run).toMatchObject({ simulated: true, status: 'QUEUED' });
    await drain();
    expect(await h.db.leadFinderRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'SUCCEEDED', simulated: true });
    const found = await h.db.leadFinderResult.findMany({ where: { runId: run.id, hasPhone: true, websiteListed: false }, orderBy: { createdAt: 'asc' }, take: 3 });
    expect(found).toHaveLength(3);
    expect(found.every((r) => r.simulated)).toBe(true);

    // ---- 2. Import three results as leads -------------------------------------------------------
    const imported = await importFinderResults(operator, { runId: run.id, resultIds: found.map((r) => r.id), requestKey: 'story-import-0001' }, { contactKeyPepper: PEPPER });
    expect(imported.counts).toMatchObject({ accepted: 3, rejected: 0, review: 0 });
    const leadIds = found.map((r) => imported.results.find((x) => x.resultId === r.id)!.leadId!);
    const leads = await h.db.lead.findMany({ where: { id: { in: leadIds } } });
    expect(leads.every((l) => l.firstSource === 'GOOGLE_PLACES' && l.websiteStatus === 'NOT_LISTED' && l.simulated && l.workspaceId === workspace.id)).toBe(true);
    // The scoring and drafting pipeline has its own tests; the story is the suite's own steps.
    await h.db.job.updateMany({ where: { type: 'pipeline.advance', status: 'QUEUED' }, data: { status: 'CANCELLED' } });
    const [lead, other1, other2] = leadIds.map((id) => leads.find((l) => l.id === id)!) as [(typeof leads)[number], (typeof leads)[number], (typeof leads)[number]];

    // ---- 3. Record a WhatsApp opt-in for one of them ---------------------------------------------
    const granted = await grantManualConsent(
      operator,
      { leadId: lead.id, channel: 'WHATSAPP', purpose: 'MARKETING', source: 'MANUAL_EVIDENCE', collectedAt: h.clock.now().toISOString(), evidence: { note: 'Said yes when we called about a website', method: 'CALL_VERBAL' }, noticeText: NOTICE },
      { contactKeyPepper: PEPPER, journalDir: h.journalDir },
    );
    expect(await h.db.consentRecord.findUniqueOrThrow({ where: { id: granted.consentId } })).toMatchObject({ leadId: lead.id, channel: 'WHATSAPP', purpose: 'MARKETING', basis: 'OPT_IN' });
    expect(await h.db.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ contactConfirmedVia: 'RECORDED_OPT_IN' });
    expect(await h.db.consentRecord.count({ where: { leadId: { in: [other1.id, other2.id] } } })).toBe(0);

    // ---- 4. A template: Generate with AI (the labelled local template), submit, simulated review -
    const copy = await generateTemplateCopy(operator, { category: 'MARKETING', language: 'en', utilityTrigger: null, purpose: 'Introduce our website design service' }, { keyRing: null });
    expect(copy.generatorLabel).toBe('local-deterministic');
    // The person points the greeting at the business name (these leads are businesses, not people).
    const draft = { ...copy.draft, name: 'story_intro', variables: copy.draft.variables.map((v) => (v.source === 'lead.firstName' ? { ...v, source: 'lead.displayName' as const } : v)) };
    const saved = await createTemplateDraft(operator, { draft, copyGeneratorLabel: 'local-deterministic' });
    expect(saved.template).toMatchObject({ status: 'DRAFT', simulated: true });
    const submitted = await submitTemplate(operator, saved.template.id, { keyRing: null, graphVersion: null, storageDir: h.storageDir });
    expect(submitted).toMatchObject({ simulated: true, template: { status: 'PENDING' } });
    h.clock.advance(31_000);
    await drain();
    const template = await h.db.whatsAppTemplate.findUniqueOrThrow({ where: { id: saved.template.id } });
    expect(template).toMatchObject({ status: 'APPROVED', origin: 'AUTHORED', category: 'MARKETING' });

    // ---- 5. Send it in bulk: the opted-in lead is queued, the others are skipped -----------------
    const bulk = { action: 'SEND_WHATSAPP_TEMPLATE' as const, templateId: template.id, variables: {}, leadIds };
    const preview = await previewBulkAction(operator, bulk, DEPS);
    expect(preview).toMatchObject({ selected: 3, eligible: 1, skipped: 2, failed: 0 });
    expect(preview.rows.filter((r) => r.outcome === 'SKIPPED').every((r) => r.reasons.join() === 'NO_WHATSAPP_OPT_IN')).toBe(true);
    const bulkRun = await requestBulkRun(operator, { ...bulk, requestKey: 'story-bulk-0001' }, DEPS);
    await drain();
    expect(await getBulkRun(operator, bulkRun.id)).toMatchObject({ status: 'COMPLETED', queued: 1, skipped: 2, failed: 0 });
    const intro = await h.db.message.findFirstOrThrow({ where: { workspaceId: workspace.id, templateId: template.id, conversation: { leadId: lead.id } } });
    expect(intro).toMatchObject({ direction: 'OUT', status: 'SENT', simulated: true, sendIntent: 'BULK' });
    expect(intro.variables).toMatchObject({ '1': lead.displayName });
    expect(await h.db.message.count({ where: { templateId: template.id, conversation: { leadId: { in: [other1.id, other2.id] } } } })).toBe(0);
    h.clock.advance(DEMO_DELIVERED_AFTER_MS);
    await drain();
    h.clock.advance(DEMO_READ_AFTER_MS);
    await drain();
    expect(await h.db.message.findUniqueOrThrow({ where: { id: intro.id } })).toMatchObject({ status: 'READ', simulated: true });

    // ---- 6. The customer replies (the DEMO inbound simulation) ----------------------------------
    h.clock.advance(60_000);
    await simulateWhatsAppInbound(operator, { leadId: lead.id, event: 'text', text: 'Hello, yes please share the details' }, receiveDeps());
    await drain();
    const conversation = await h.db.conversation.findFirstOrThrow({ where: { leadId: lead.id, channel: 'WHATSAPP' } });
    expect(conversation.lastInboundProviderAt).not.toBeNull();
    expect(await h.db.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ salesStage: 'REPLIED' });
    const thread = await getInboxThread(operator, conversation.id, DEPS);
    expect(thread.messages.map((m) => m.direction)).toContain('IN');

    // ---- 7. Automatic replies: the AI answers a service question in AUTO -------------------------
    expect(await getWorkspaceAutoSend(operator)).toMatchObject({ enabled: true });
    await setConversationAiMode(operator, { conversationId: conversation.id, aiMode: 'AUTO' });
    h.clock.advance(30_000);
    const asked = await simulateWhatsAppInbound(operator, { leadId: lead.id, event: 'text', text: 'Do you build online stores and how long does it take?' }, receiveDeps());
    await drain();
    const question = await h.db.message.findFirstOrThrow({ where: { workspaceId: workspace.id, direction: 'IN', providerMessageId: asked.messageId } });
    const replies = await h.db.message.findMany({ where: { workspaceId: workspace.id, direction: 'OUT', replyToInboundId: question.id } });
    expect(replies).toHaveLength(1);
    const reply = replies[0]!;
    expect(reply).toMatchObject({ status: 'SENT', simulated: true, sendIntent: 'AUTOMATED', generatorLabel: 'local-deterministic' });
    expect(reply.body!.startsWith(automatedReplyDisclosure(BUSINESS))).toBe(true);
    // Catalog facts only: the matched service by name, with its typical timeline.
    expect(reply.body!.toLowerCase()).toContain('e-commerce store');
    expect(reply.body).toMatch(/about 4 weeks/);
    h.clock.advance(DEMO_DELIVERED_AFTER_MS);
    await drain();
    h.clock.advance(DEMO_READ_AFTER_MS);
    await drain();
    expect(await h.db.message.findUniqueOrThrow({ where: { id: reply.id } })).toMatchObject({ status: 'READ', simulated: true });

    // ---- 8. Hand over to the client: the AI stops, the operator is read-only ---------------------
    const stageVersion = (await h.db.lead.findUniqueOrThrow({ where: { id: lead.id } })).stageVersion;
    const handoff = await handOverLead(operator, { leadId: lead.id, note: 'Interested in an online store; prefers WhatsApp.', expectedStageVersion: stageVersion, requestKey: requestKey('story') }, DEMO_AI);
    expect(handoff).toMatchObject({ created: true, summaryStatus: 'PENDING', lead: { salesStage: 'CONVERTED' } });
    await drain();
    expect(await h.db.leadHandoff.findUniqueOrThrow({ where: { id: handoff.handoffId } })).toMatchObject({ status: 'HANDED_OVER', summaryStatus: 'READY', summaryGeneratorLabel: 'local-deterministic' });
    expect(await h.db.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).toMatchObject({ aiMode: 'OFF', humanTakeover: true });

    h.clock.advance(60_000);
    const sentBefore = await h.db.message.count({ where: { workspaceId: workspace.id, direction: 'OUT', conversationId: conversation.id } });
    const later = await simulateWhatsAppInbound(operator, { leadId: lead.id, event: 'text', text: 'Can you also do a logo?' }, receiveDeps());
    await drain();
    expect(await h.db.message.count({ where: { workspaceId: workspace.id, direction: 'IN', providerMessageId: later.messageId } })).toBe(1);
    expect(await h.db.message.count({ where: { workspaceId: workspace.id, direction: 'OUT', conversationId: conversation.id } })).toBe(sentBefore);
    await expect(sendComposerMessage(operator, { conversationId: conversation.id, requestKey: 'story-composer-op1', kind: 'TEXT', body: 'Any update?' }, DEPS)).rejects.toMatchObject({ status: 409, code: 'HANDED_OVER' });
    const operatorRow = (await listInboxThreads(operator, { filter: 'all' })).rows.find((r) => r.conversationId === conversation.id);
    expect(operatorRow).toMatchObject({ handedOverAt: expect.any(Date) });

    // ---- 9. The client sees it, acknowledges and carries on -------------------------------------
    const needs = await loadClientCommandCenter(client);
    expect(needs.needsYou.ok && needs.needsYou.value.find((i) => i.id === 'handedOverLeads')?.count).toBeGreaterThanOrEqual(1);
    expect((await listClientHandoffs(client, { status: 'open' })).map((x) => x.id)).toContain(handoff.handoffId);
    const view = await loadLeadHandoff(client, lead.id);
    expect(view.handoff).toMatchObject({ status: 'HANDED_OVER', summaryStatus: 'READY' });
    expect(view.handoff?.summary).not.toBeNull();
    expect(await acknowledgeHandoff(client, { handoffId: handoff.handoffId })).toEqual({ handoffId: handoff.handoffId, status: 'ACKNOWLEDGED', changed: true });
    expect((await listClientHandoffs(client, { status: 'open' })).map((x) => x.id)).not.toContain(handoff.handoffId);
    const clientSend = await sendComposerMessage(client, { conversationId: conversation.id, requestKey: 'story-composer-client1', kind: 'TEXT', body: 'Hi, this is Aarav from the studio. When can we talk?' }, DEPS);
    expect(clientSend.created).toBe(true);
    await drain();
    expect(await h.db.message.findUniqueOrThrow({ where: { id: clientSend.messageId } })).toMatchObject({ status: 'SENT', simulated: true, sendIntent: 'MANUAL_SINGLE' });

    // ---- DEMO makes zero outbound calls ----------------------------------------------------------
    expect(tripwire).toEqual({ connect: 0, tls: 0, lookup: 0, fetch: 0 });
    expect(outboundAttempts()).toEqual([]);
    expect(h.wa.calls).toEqual([]);
    expect(h.email.calls).toEqual([]);
    const outbox = readDemoOutbox(demoOutboxDir(h.storageDir), 'WHATSAPP');
    const sentIds = [intro.id, reply.id, clientSend.messageId];
    const providerIds = (await h.db.message.findMany({ where: { id: { in: sentIds } }, select: { providerMessageId: true } })).map((m) => m.providerMessageId).sort();
    expect(outbox.map((e) => e.providerMessageId).sort()).toEqual(providerIds);
    expect(outbox).toHaveLength(3);
    // Everything the story wrote is flagged simulated; nothing real was claimed.
    expect(await h.db.message.count({ where: { workspaceId: workspace.id, direction: 'OUT', simulated: false } })).toBe(0);
    expect(await h.db.leadFinderResult.count({ where: { runId: run.id, simulated: false } })).toBe(0);
  }, 180_000);
});
