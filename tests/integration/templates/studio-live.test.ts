// ADR-123 (slice F4), LIVE submission through a scripted Graph transport (documented-shape
// fixtures in tests/fixtures/whatsapp/template-admin; not live-verified):
// - Without a stored WhatsApp integration no draft is saved (422); without a verified one with a
//   WABA ID nothing is submitted (422, audited DENIED, no request).
// - Submit: DRAFT -> SUBMITTING + one `wa.templateSubmit` job, which POSTs /<WABA>/message_templates
//   with {name, language, category, components} (Bearer token, never in a URL); created -> Meta's
//   status and category and the provider id, then `wa.templateSync` keyed
//   wa.templateSync:<integrationId>:submit:<templateId>:<time> 60 s later resolves the review.
// - A timeout after the write, a 5xx, "name exists" or a crashed earlier attempt never resubmits:
//   the row stays SUBMITTING and the sync resolves it by name and language (found: Meta's status;
//   absent from a complete list: back to DRAFT, NOT_FOUND_AFTER_SUBMIT).
// - A definite refusal (invalid, auth, throttled) or a failure before the write: back to DRAFT with
//   the reason, shown on the studio.
// - Sync of authored rows: rejection reason stored, a local DRAFT never overwritten (draft
//   conflict) and never counted missing. A rejected authored template is deleted at Meta by name.
// - LIVE "Generate with AI" without an AI integration is 422 AI_NOT_CONFIGURED (no silent local).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@/lib/logger';
import { defaultButtons, templateComponentsOf, type TemplateDraft } from '@/lib/domain/template-authoring';
import { createTemplateReviewJob } from '@/server/jobs/handlers/template-review';
import { createTemplateSubmitJob } from '@/server/jobs/handlers/template-submit';
import { createTemplateSyncJob } from '@/server/jobs/handlers/template-sync';
import { buildJobRegistry } from '@/server/jobs/registry';
import { generateTemplateCopy } from '@/server/services/ai/template-copy';
import { liveAdapters } from '@/server/services/integrations/live-adapters';
import { createTemplateDraft, deleteTemplate, getTemplateStudio, submitTemplate } from '@/server/services/integrations/template-authoring';
import { syncWhatsAppTemplates } from '@/server/services/integrations/templates';
import { createWorker, type Worker } from '../../../worker/worker';
import { networkError } from '../contract/whatsapp-support';
import { ACCESS_TOKEN, createLiveHarness, liveLead, queueWhatsApp, storeWhatsApp, WABA_ID, type LiveHarness } from '../integrations/live-support';

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/whatsapp/template-admin');
const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
const statusOf = (name: string): number => (fixture('SOURCES.json') as { files: Record<string, { httpStatus: number }> }).files[name]!.httpStatus;
const answer = (name: string) => ({ status: statusOf(name), body: fixture(name) });
const CREATE_PATH = new RegExp(`^/v24\\.0/${WABA_ID}/message_templates$`);

let h: LiveHarness;
let worker: Worker;
const drain = async () => {
  let ran = 0;
  while ((await worker.tick()) === 'ran') ran += 1;
  return ran;
};
const deps = () => ({ keyRing: h.flags.keyRing, graphVersion: h.flags.graphVersion, storageDir: h.storageDir, graph: { http: h.graph.http } });

beforeAll(async () => {
  h = await createLiveHarness('f4-studio-live');
  const defs = [
    createTemplateSubmitJob({ deps: () => ({ ...deps(), mode: 'live' }) }),
    createTemplateReviewJob({ mode: () => 'live' }),
    createTemplateSyncJob({ mode: () => 'live', deps: h.deps }),
  ];
  worker = createWorker(
    { db: h.db, clock: h.clock, registry: buildJobRegistry(defs), logger: createLogger({ level: 'silent' }), mode: 'live', version: 'test', random: () => 0 },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
}, 120_000);
afterAll(async () => h?.destroy());
beforeEach(async () => {
  h.graph.reset();
  // Each test drains its own follow-up syncs; a leftover one must not consume another test's script.
  await h.db.job.updateMany({ where: { status: 'QUEUED' }, data: { status: 'CANCELLED' } });
});

let seq = 0;
function draft(over: Partial<TemplateDraft> = {}): TemplateDraft {
  seq += 1;
  return {
    category: 'MARKETING',
    language: 'en',
    name: `live_template_${seq}`,
    utilityTrigger: null,
    header: { format: 'TEXT', text: 'A website for your business', example: null },
    body: 'Hello {{1}}, {{2}} builds fast websites for local businesses. Reply to see our work.',
    variables: [
      { position: '1', source: 'lead.firstName', example: 'Ravi' },
      { position: '2', source: 'workspace.name', example: 'Live Dental Co' },
    ],
    footer: 'Tap Stop to opt out',
    buttons: defaultButtons('MARKETING'),
    ...over,
  };
}

const row = (id: string) => h.db.whatsAppTemplate.findUniqueOrThrow({ where: { id } });
/** The template's submission audits, oldest first; at one instant the "queued" request comes before its outcome. */
async function audits(id: string) {
  const rows = await h.db.auditEvent.findMany({ where: { action: 'template.submit', targetId: id } });
  const rank = (a: { summary: unknown }) => ((a.summary as { outcome?: string }).outcome === 'QUEUED' ? 0 : 1);
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || rank(a) - rank(b));
}

async function submitted(over: Partial<TemplateDraft> = {}) {
  const ctx = await h.owner();
  const created = await createTemplateDraft(ctx, { draft: draft(over), copyGeneratorLabel: null });
  const result = await submitTemplate(ctx, created.template.id, deps());
  expect(result).toMatchObject({ simulated: false, reviewAt: null, template: { status: 'SUBMITTING' } });
  return created.template.id;
}

describe('configuration gates', () => {
  it('no WhatsApp: no draft; not verified: no submission (422, audited DENIED, no request)', async () => {
    const ctx = await h.owner();
    await expect(createTemplateDraft(ctx, { draft: draft(), copyGeneratorLabel: null })).rejects.toMatchObject({ status: 422, code: 'INTEGRATION_NOT_CONFIGURED' });
    expect((await getTemplateStudio(ctx, { graphVersion: 'v24.0' })).whatsapp).toMatchObject({ canDraft: false, canSubmit: false, problem: expect.stringContaining('Set up WhatsApp') });

    await storeWhatsApp(h, { status: 'CONFIGURED_UNVERIFIED' });
    const created = await createTemplateDraft(ctx, { draft: draft(), copyGeneratorLabel: null });
    expect(created.template.simulated).toBe(false);
    expect((await getTemplateStudio(ctx, { graphVersion: 'v24.0' })).whatsapp).toMatchObject({ canDraft: true, canSubmit: false, problem: expect.stringContaining('verify') });
    await expect(submitTemplate(ctx, created.template.id, deps())).rejects.toMatchObject({ status: 422, code: 'INTEGRATION_NOT_CONFIGURED' });
    expect((await row(created.template.id)).status).toBe('DRAFT');
    expect((await audits(created.template.id)).map((a) => a.result)).toEqual(['DENIED']);
    expect(h.graph.requests).toHaveLength(0);
    expect(await h.db.job.count({ where: { type: 'wa.templateSubmit' } })).toBe(0);

    await storeWhatsApp(h, { status: 'CONNECTED' });
    expect((await getTemplateStudio(ctx, { graphVersion: 'v24.0' })).whatsapp).toMatchObject({ canDraft: true, canSubmit: true, problem: null });
    expect((await getTemplateStudio(ctx, { graphVersion: null })).whatsapp).toMatchObject({ canSubmit: false, problem: expect.stringContaining('META_GRAPH_VERSION') });
  });
});

describe('submission', () => {
  // The WhatsApp setup these tests need is made here, not left by the gates test above.
  beforeEach(async () => void (await storeWhatsApp(h, { status: 'CONNECTED' })));

  it('creates the template at Meta, stores the provider id and status, and the follow-up sync (60 s later) records the review', async () => {
    const id = await submitted();
    const stored = await row(id);
    expect(stored).toMatchObject({ status: 'SUBMITTING', submittedAt: h.clock.now() });
    const job = await h.db.job.findFirstOrThrow({ where: { type: 'wa.templateSubmit' }, orderBy: { createdAt: 'desc' } });
    expect(job).toMatchObject({ idempotencyKey: `wa.templateSubmit:${id}:${h.clock.now().getTime()}`, maxAttempts: 5 });

    h.graph.on('POST', CREATE_PATH, answer('response.template-create.json'));
    await drain();
    expect(h.graph.unexpected).toEqual([]);
    const [req] = h.graph.requests;
    expect(req).toMatchObject({ method: 'POST', path: `/v24.0/${WABA_ID}/message_templates`, query: {} });
    expect(req!.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(req!.url).not.toContain(ACCESS_TOKEN);
    expect(req!.body).toEqual({ name: stored.name, language: 'en', category: 'MARKETING', components: templateComponentsOf(draft({ name: stored.name })) });

    const after = await row(id);
    expect(after).toMatchObject({ status: 'PENDING', providerTemplateId: '594425479261596', category: 'MARKETING' });
    const sync = await h.db.job.findFirstOrThrow({ where: { type: 'wa.templateSync', idempotencyKey: { contains: `:submit:${id}:` } } });
    const integration = await h.db.integration.findFirstOrThrow({ where: { workspaceId: h.workspaceId, kind: 'WHATSAPP_CLOUD' } });
    expect(sync.idempotencyKey).toBe(`wa.templateSync:${integration.id}:submit:${id}:${stored.submittedAt!.getTime()}`);
    expect(sync.runAt.getTime() - h.clock.now().getTime()).toBe(60_000);
    expect((await audits(id)).map((a) => [a.result, (a.summary as { outcome: string }).outcome])).toEqual([
      ['SUCCESS', 'QUEUED'],
      ['SUCCESS', 'SUBMITTED'],
    ]);

    // Meta approves it; the follow-up sync finds it by name and language.
    const page = fixture('response.templates-authored.json') as { data: Array<Record<string, unknown>> };
    h.graph.on('GET', CREATE_PATH, { status: 200, body: { data: [{ ...page.data[0], name: stored.name }] } });
    h.clock.advance(60_000);
    await drain();
    expect(await row(id)).toMatchObject({ status: 'APPROVED', providerTemplateId: '594425479261596', rejectedReason: null, syncedAt: h.clock.now() });
    expect(h.demoOutboxExists()).toBe(false);
  });

  it('stores the category Meta reports when it differs from the one submitted', async () => {
    const id = await submitted({ category: 'UTILITY', utilityTrigger: 'QUOTE_ISSUED', buttons: [], footer: null, body: 'Hello {{1}}, {{2}} has issued the quotation you asked about today.' });
    h.graph.on('POST', CREATE_PATH, answer('response.template-create-recategorized.json'));
    await drain();
    expect(await row(id)).toMatchObject({ status: 'PENDING', category: 'MARKETING', utilityTrigger: 'QUOTE_ISSUED' });
    const last = (await audits(id)).at(-1)!;
    expect(last.summary).toMatchObject({ outcome: 'SUBMITTED', categoryChanged: true });
  });

  it('a timeout after the write never resubmits: SUBMITTING, then the sync confirms it by name and language', async () => {
    const id = await submitted();
    const name = (await row(id)).name;
    h.graph.on('POST', CREATE_PATH, { throw: networkError('UND_ERR_HEADERS_TIMEOUT') });
    await drain();
    expect(h.graph.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect((await row(id)).status).toBe('SUBMITTING');
    expect((await audits(id)).at(-1)!.summary).toMatchObject({ outcome: 'CONFIRMING', errorCode: 'WRITE_TIMEOUT' });

    h.graph.on('GET', CREATE_PATH, { status: 200, body: { data: [{ id: '594425479261700', name, language: 'en', status: 'PENDING', category: 'MARKETING', components: [] }] } });
    h.clock.advance(60_000);
    await drain();
    expect(h.graph.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(await row(id)).toMatchObject({ status: 'PENDING', providerTemplateId: '594425479261700' });
  });

  it('a template Meta never created goes back to DRAFT after the sync (NOT_FOUND_AFTER_SUBMIT), shown on the studio', async () => {
    const id = await submitted();
    h.graph.on('POST', CREATE_PATH, { status: 503, body: { error: { message: 'Service temporarily unavailable', code: 2 } } });
    await drain();
    expect((await row(id)).status).toBe('SUBMITTING');
    expect((await audits(id)).at(-1)!.summary).toMatchObject({ outcome: 'CONFIRMING', errorCode: 'PROVIDER_UNAVAILABLE' });
    h.graph.on('GET', CREATE_PATH, { status: 200, body: { data: [] } });
    h.clock.advance(60_000);
    await drain();
    expect((await row(id)).status).toBe('DRAFT');
    const last = (await audits(id)).at(-1)!;
    expect(last).toMatchObject({ result: 'FAILED' });
    expect(last.summary).toMatchObject({ outcome: 'NOT_CREATED', errorCode: 'NOT_FOUND_AFTER_SUBMIT' });
    const view = (await getTemplateStudio(await h.owner(), { graphVersion: 'v24.0' })).templates.find((t) => t.id === id)!;
    expect(view).toMatchObject({ status: 'DRAFT', submittable: true, lastSubmit: { result: 'FAILED', errorCode: 'NOT_FOUND_AFTER_SUBMIT', message: expect.stringContaining('Submit again') } });
  });

  it('"name already exists" and a crashed earlier attempt are confirmed by the sync, never resubmitted', async () => {
    const taken = await submitted();
    h.graph.on('POST', CREATE_PATH, answer('error.template-name-taken.json'));
    await drain();
    expect((await row(taken)).status).toBe('SUBMITTING');
    expect((await audits(taken)).at(-1)!.summary).toMatchObject({ outcome: 'CONFIRMING', errorCode: 'TEMPLATE_NAME_TAKEN' });

    const crashed = await submitted();
    // The worker died during the call: the requeued job runs as attempt 2.
    await h.db.job.updateMany({ where: { type: 'wa.templateSubmit', idempotencyKey: { startsWith: `wa.templateSubmit:${crashed}:` } }, data: { attempts: 1 } });
    h.graph.reset();
    await drain();
    expect(h.graph.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
    expect((await row(crashed)).status).toBe('SUBMITTING');
    expect((await audits(crashed)).at(-1)!.summary).toMatchObject({ outcome: 'CONFIRMING', errorCode: 'INTERRUPTED' });
    // Both are resolved by the sync (found by name: the earlier submission had landed).
    const names = [(await row(taken)).name, (await row(crashed)).name];
    h.graph.on('GET', CREATE_PATH, { status: 200, body: { data: names.map((n, i) => ({ id: `59442547926180${i}`, name: n, language: 'en', status: 'PENDING', category: 'MARKETING', components: [] })) } }, { status: 200, body: { data: names.map((n, i) => ({ id: `59442547926180${i}`, name: n, language: 'en', status: 'PENDING', category: 'MARKETING', components: [] })) } });
    h.clock.advance(60_000);
    await drain();
    expect((await row(taken)).status).toBe('PENDING');
    expect((await row(crashed)).status).toBe('PENDING');
  });

  it('a definite refusal or a failure before the write goes back to DRAFT with the reason', async () => {
    const cases: Array<[unknown, string]> = [
      [answer('error.template-invalid.json'), 'TEMPLATE_REJECTED_BY_PROVIDER'],
      [answer('error.template-auth.json'), 'PROVIDER_AUTH'],
      [answer('error.template-throttled.json'), 'PROVIDER_RATE_LIMITED'],
      [{ throw: networkError('ENOTFOUND') }, 'PROVIDER_UNREACHABLE'],
    ];
    for (const [response, code] of cases) {
      const id = await submitted();
      h.graph.reset();
      h.graph.on('POST', CREATE_PATH, response as never);
      await drain();
      expect((await row(id)).status, code).toBe('DRAFT');
      const last = (await audits(id)).at(-1)!;
      expect(last.result).toBe('FAILED');
      expect(last.summary).toMatchObject({ outcome: 'NOT_CREATED', errorCode: code });
      expect(JSON.stringify(last.summary)).not.toContain(ACCESS_TOKEN);
    }
    const invalid = (await getTemplateStudio(await h.owner(), { graphVersion: 'v24.0' })).templates.find((t) => t.lastSubmit?.errorCode === 'TEMPLATE_REJECTED_BY_PROVIDER')!;
    expect(invalid.lastSubmit!.message).toContain('Meta refused the template.');
    expect(invalid.lastSubmit!.message).toContain("Variables can't be at the start or end");
  });
});

describe('sync of authored rows', () => {
  beforeEach(async () => void (await storeWhatsApp(h, { status: 'CONNECTED' })));

  it('stores the rejection reason, never touches a local draft of the same name, never counts drafts or submissions missing', async () => {
    const ctx = await h.owner();
    // An authored template that Meta will report REJECTED, a local draft whose name Meta also lists,
    // and a submission still in flight (SUBMITTING, younger than a minute).
    const rejected = await createTemplateDraft(ctx, { draft: draft({ name: 'festive_launch', body: 'Hello {{1}}, our festive website launch is here. Reply to know more.', variables: [{ position: '1', source: 'lead.firstName', example: 'Ravi' }] }), copyGeneratorLabel: null });
    await submitTemplate(ctx, rejected.template.id, deps());
    h.graph.on('POST', CREATE_PATH, answer('response.template-create.json'));
    await drain();
    await h.db.job.updateMany({ where: { status: 'QUEUED' }, data: { status: 'CANCELLED' } });
    const clash = await createTemplateDraft(ctx, { draft: draft({ name: 'draft_clash' }), copyGeneratorLabel: null });
    h.clock.advance(120_000);
    const inFlight = await submitted();
    const listed = new Set(['website_intro', 'festive_launch', 'draft_clash']);
    const all = await h.db.whatsAppTemplate.findMany({ where: { workspaceId: h.workspaceId }, select: { name: true, status: true } });
    const expectedMissing = all.filter((t) => !listed.has(t.name) && !['DRAFT', 'SUBMITTING'].includes(t.status)).length;

    h.graph.reset();
    h.graph.on('GET', CREATE_PATH, answer('response.templates-authored.json'));
    const result = await syncWhatsAppTemplates(ctx, { liveSync: liveAdapters(h.deps()).templateSync });
    expect(await row(rejected.template.id)).toMatchObject({ status: 'REJECTED', rejectedReason: 'INVALID_FORMAT', providerTemplateId: '594425479261598' });
    const clashRow = await row(clash.template.id);
    expect(clashRow).toMatchObject({ status: 'DRAFT', providerTemplateId: null, syncedAt: null });
    expect(clashRow.components).toEqual(templateComponentsOf(clash.template.draft!));
    expect(await row(inFlight)).toMatchObject({ status: 'SUBMITTING' });
    expect(result.missing).toBe(expectedMissing);
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'integration.templates.sync', workspaceId: h.workspaceId, createdAt: h.clock.now() } });
    expect(audit.summary).toMatchObject({ outcome: 'SYNCED', draftConflicts: 1, missing: expectedMissing, submitsUnconfirmed: 0 });
  });

  it('deletes a rejected authored template at Meta by name, then here', async () => {
    const ctx = await h.owner();
    // Its own rejected template (as Meta's sync leaves one), not the row another test left behind.
    const made = await createTemplateDraft(ctx, { draft: draft({ name: 'festive_delete' }), copyGeneratorLabel: null });
    await h.db.whatsAppTemplate.update({ where: { id: made.template.id }, data: { status: 'REJECTED', rejectedReason: 'INVALID_FORMAT', providerTemplateId: '594425479261598' } });
    const rejected = await h.db.whatsAppTemplate.findUniqueOrThrow({ where: { id: made.template.id } });
    h.graph.reset();
    h.graph.on('DELETE', CREATE_PATH, answer('response.template-delete.json'));
    await deleteTemplate(ctx, rejected.id, deps());
    expect(h.graph.requests).toHaveLength(1);
    expect(h.graph.requests[0]).toMatchObject({ method: 'DELETE', path: `/v24.0/${WABA_ID}/message_templates`, query: { name: 'festive_delete', hsm_id: '594425479261598' } });
    expect(await h.db.whatsAppTemplate.count({ where: { id: rejected.id } })).toBe(0);
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'template.delete', targetId: rejected.id } });
    expect(audit).toMatchObject({ simulated: false });
    expect(audit.summary).toMatchObject({ atProvider: true, status: 'REJECTED' });
  });

  it('never deletes a sibling language at Meta: without a template id a same-named template here blocks the delete', async () => {
    const ctx = await h.owner();
    const en = await createTemplateDraft(ctx, { draft: draft({ name: 'intro_offer', language: 'en' }), copyGeneratorLabel: null });
    await h.db.whatsAppTemplate.update({ where: { id: en.template.id }, data: { status: 'APPROVED', providerTemplateId: '111' } });
    const hi = await createTemplateDraft(ctx, { draft: draft({ name: 'intro_offer', language: 'hi' }), copyGeneratorLabel: null });
    await h.db.whatsAppTemplate.update({ where: { id: hi.template.id }, data: { status: 'REJECTED', providerTemplateId: null } });
    h.graph.reset();
    await expect(deleteTemplate(ctx, hi.template.id, deps())).rejects.toMatchObject({ status: 409, code: 'TEMPLATE_NOT_DELETABLE' });
    expect(h.graph.requests).toEqual([]);
    expect(await h.db.whatsAppTemplate.count({ where: { id: hi.template.id } })).toBe(1);
    // With its own template id Meta is told which one: only the Hindi template goes.
    await h.db.whatsAppTemplate.update({ where: { id: hi.template.id }, data: { providerTemplateId: '222' } });
    h.graph.on('DELETE', CREATE_PATH, answer('response.template-delete.json'));
    await deleteTemplate(ctx, hi.template.id, deps());
    expect(h.graph.requests[0]).toMatchObject({ method: 'DELETE', query: { name: 'intro_offer', hsm_id: '222' } });
    expect(await h.db.whatsAppTemplate.count({ where: { id: en.template.id } })).toBe(1);
  });

  it('a rejected template that already has messages is kept, and Meta is not asked to delete it', async () => {
    const ctx = await h.owner();
    const created = await createTemplateDraft(ctx, { draft: draft({ name: 'rejected_with_history' }), copyGeneratorLabel: null });
    await h.db.whatsAppTemplate.update({ where: { id: created.template.id }, data: { status: 'APPROVED' } });
    const lead = await liveLead(h);
    await queueWhatsApp(h, ctx, { leadId: lead.id, sendIntent: 'MANUAL_SINGLE', templateId: created.template.id, variables: { '1': 'Ravi', '2': 'Live Dental Co' } });
    // Meta later reports it REJECTED (a re-review): the history of the sends must stay.
    await h.db.whatsAppTemplate.update({ where: { id: created.template.id }, data: { status: 'REJECTED' } });
    h.graph.reset();
    await expect(deleteTemplate(ctx, created.template.id, deps())).rejects.toMatchObject({ status: 409, code: 'TEMPLATE_NOT_DELETABLE' });
    expect(h.graph.requests).toEqual([]);
    expect(await h.db.whatsAppTemplate.count({ where: { id: created.template.id } })).toBe(1);
  });

  it('asks Meta for rejected_reason, and keeps the id and the reason of a rejected template that was made in WhatsApp Manager', async () => {
    const ctx = await h.owner();
    h.clock.advance(61_000);
    h.graph.on('GET', CREATE_PATH, {
      status: 200,
      body: {
        data: [{ id: '700100200300', name: 'manager_made_rejected', language: 'en', status: 'REJECTED', category: 'MARKETING', rejected_reason: 'ABUSIVE_CONTENT', components: [{ type: 'BODY', text: 'Hi there, a short note about our work.' }] }],
        paging: { cursors: { before: 'QVFIUBEFORE', after: 'QVFIUAFTER' } },
      },
    });
    await syncWhatsAppTemplates(ctx, { liveSync: liveAdapters(h.deps()).templateSync });
    // The list only carries the verdict when it is asked for: it is not one of Meta's default fields.
    expect(h.graph.requests[0]!.query.fields).toContain('rejected_reason');
    const made = await h.db.whatsAppTemplate.findFirstOrThrow({ where: { workspaceId: h.workspaceId, name: 'manager_made_rejected' } });
    expect(made).toMatchObject({ origin: 'SYNCED', status: 'REJECTED', providerTemplateId: '700100200300', rejectedReason: 'ABUSIVE_CONTENT' });
  });
});

describe('Generate with AI in LIVE', () => {
  it('without an AI integration: 422 AI_NOT_CONFIGURED, never the local generator silently', async () => {
    const ctx = await h.owner();
    expect((await getTemplateStudio(ctx, { graphVersion: 'v24.0' })).ai).toEqual({ local: false, available: false });
    await expect(generateTemplateCopy(ctx, { category: 'MARKETING', language: 'en', utilityTrigger: null, purpose: '' }, { keyRing: h.flags.keyRing })).rejects.toMatchObject({ status: 422, code: 'AI_NOT_CONFIGURED' });
    // An explicit local action is allowed and labelled as such.
    const local = await generateTemplateCopy(ctx, { category: 'MARKETING', language: 'en', utilityTrigger: null, purpose: '', local: true }, { keyRing: h.flags.keyRing });
    expect(local.generatorLabel).toBe('local-deterministic');
  });
});
