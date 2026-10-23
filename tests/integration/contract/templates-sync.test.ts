// T32 template sync and mapping (ADR-17, P12, plan §5.1, §7 check 7; fixture-tested, not
// live-verified):
// - The live sync pages through GET /<waba>/message_templates with the `after` cursor (the `next`
//   URL in an answer is never followed) and stores every template with its raw provider status,
//   category and components; quick-reply intents are proposed from the button texts; templates
//   start unmapped. A re-sync updates status and category (category history appended), keeps the
//   mapping, counts templates the provider no longer lists as missing, and leaves them unchanged.
// - A PAUSED (or REJECTED) template blocks the queued sends that use it: TEMPLATE_NOT_APPROVED at
//   preflight, no provider request.
// - Quota safety: one manual sync per minute per integration (429 with Retry-After).
// - Mapping: intent, variable sources and quick-reply intents (integrations.manage); the mapped
//   payload ids are what a send carries.
// - The scheduled `wa.templateSync` job (armed by a successful connection test) applies the same
//   sync; a failed fetch changes nothing and is audited FAILED.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PermissionDeniedError, RateLimitedError, ValidationError } from '@/lib/errors';
import { getIntegrationSetup } from '@/server/services/integrations/center';
import { testIntegrationConnection } from '@/server/services/integrations/connection-test';
import { liveAdapters } from '@/server/services/integrations/live-adapters';
import { WA_TEMPLATE_SYNC_JOB } from '@/server/services/integrations/schedules';
import { quickReplyPayloadsFor, saveTemplateMapping } from '@/server/services/integrations/template-sync';
import { syncWhatsAppTemplates } from '@/server/services/integrations/templates';
import { checkDispatchEligibility } from '@/server/services/messaging/eligibility';
import { createLiveHarness, liveLead, PEPPER, PHONE_ID, queueWhatsApp, storeWhatsApp, WABA_ID, type LiveHarness } from '../integrations/live-support';
import { fixtureAnswer, waFixture } from './whatsapp-support';

let h: LiveHarness;

beforeAll(async () => {
  h = await createLiveHarness('t32-templates-sync');
  await storeWhatsApp(h, { status: 'CONNECTED' });
}, 120_000);
afterAll(async () => h?.destroy());
beforeEach(() => h.graph.reset());

const sync = async () => syncWhatsAppTemplates(await h.owner(), { liveSync: liveAdapters(h.deps()).templateSync });
const templates = () => h.db.whatsAppTemplate.findMany({ where: { workspaceId: h.workspaceId }, orderBy: { name: 'asc' } });
const tpl = async (name: string) => h.db.whatsAppTemplate.findFirstOrThrow({ where: { workspaceId: h.workspaceId, name } });

describe('live sync', () => {
  it('stores raw status, category and components from every page; proposes quick-reply intents; starts unmapped', async () => {
    h.graph.on('GET', new RegExp(`^/v24\\.0/${WABA_ID}/message_templates$`), fixtureAnswer('response.templates-page-1.json'), fixtureAnswer('response.templates-page-2.json'));
    const result = await sync();
    expect(result).toMatchObject({ simulated: false, created: 4, updated: 0, existing: 0, missing: 0 });

    const [first, second] = h.graph.requests;
    // ADR-123 (slice F4): `rejected_reason` is not a default field of the list; unless it is asked for, Meta's verdict on a rejected template is never seen.
    expect(first!.query).toMatchObject({ fields: 'id,name,language,status,category,components,rejected_reason', limit: '100' });
    expect(first!.query.after).toBeUndefined();
    expect(second!.query.after).toBe('QVFIUAFTER1');
    expect(second!.path).toBe(`/v24.0/${WABA_ID}/message_templates`);

    const rows = await templates();
    expect(rows.map((t) => [t.name, t.language, t.status, t.category])).toEqual([
      ['festive_offer_blast', 'en', 'REJECTED', 'MARKETING'],
      ['quote_ready_doc', 'en', 'APPROVED', 'UTILITY'],
      ['seasonal_promo_image', 'hi', 'PENDING', 'MARKETING'],
      ['welcome_first_touch', 'en', 'APPROVED', 'MARKETING'],
    ]);
    const doc = await tpl('quote_ready_doc');
    expect(doc.components).toEqual(waFixture('template.quote-ready-doc.components.json'));
    expect(doc.intent).toBeNull();
    expect(doc.variableMap).toEqual({ body: {}, buttons: { '0': 'QUOTE', '1': 'CALL', '2': 'STOP' } });
    expect(doc.variableSchema).toEqual([
      { name: '1', component: 'BODY', source: null },
      { name: '2', component: 'BODY', source: null },
    ]);
    expect(doc.categoryHistory).toEqual([{ category: 'UTILITY', at: h.clock.now().toISOString() }]);

    const setup = await getIntegrationSetup(await h.owner(), 'WHATSAPP_CLOUD');
    const image = setup.templates.find((t) => t.name === 'seasonal_promo_image')!;
    expect(image.notSendable).toMatch(/image, video or location header/);
    expect(setup.templates.find((t) => t.name === 'quote_ready_doc')).toMatchObject({ documentHeader: true, notSendable: null, variables: ['1', '2'] });
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'integration.templates.sync', result: 'SUCCESS' } });
    expect(audit.summary).toMatchObject({ outcome: 'SYNCED', created: 4, complete: true, trigger: 'manual' });
  });

  it('allows one manual sync per minute per integration (429 TEMPLATE_SYNC_TOO_SOON, nothing fetched)', async () => {
    const err = await sync().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err).toMatchObject({ code: 'TEMPLATE_SYNC_TOO_SOON', status: 429 });
    expect((err as RateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
    expect(h.graph.requests).toHaveLength(0);
  });

  it('a mapping sets intent, variable sources and quick-reply intents; the send carries the mapped payload ids', async () => {
    const welcome = await tpl('welcome_first_touch');
    const mapped = await saveTemplateMapping(await h.owner(), { templateId: welcome.id, intent: 'FIRST_TOUCH', variables: { '1': 'lead.displayName', '2': 'ai.firstTouch' }, buttons: { '0': 'QUOTE', '1': 'STOP' } });
    expect(mapped).toMatchObject({ intent: 'FIRST_TOUCH', mapping: { body: { '1': 'lead.displayName', '2': 'ai.firstTouch' }, buttons: { '0': 'QUOTE', '1': 'STOP' } } });
    const stored = await tpl('welcome_first_touch');
    expect(quickReplyPayloadsFor(stored)).toEqual([
      { index: 0, payload: 'AL_QR_QUOTE_V1' },
      { index: 1, payload: 'AL_QR_STOP_V1' },
    ]);
    const bad = await saveTemplateMapping(await h.owner(), { templateId: welcome.id, intent: null, variables: { '3': 'manual' }, buttons: {} }).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(ValidationError);
    expect(bad).toMatchObject({ code: 'TEMPLATE_MAPPING_INVALID' });
    await expect(saveTemplateMapping(await h.member(), { templateId: welcome.id, intent: 'FOLLOW_UP', variables: {}, buttons: {} })).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await h.db.auditEvent.count({ where: { action: 'integration.template.map', targetId: welcome.id } })).toBe(1);
  });

  it('a re-sync stores the new raw status and category, keeps the mapping, and counts unlisted templates as missing', async () => {
    h.clock.advance(61_000);
    h.graph.on('GET', /\/message_templates$/, fixtureAnswer('response.templates-paused.json'));
    const result = await sync();
    expect(result).toMatchObject({ created: 0, updated: 2, existing: 0, missing: 2 });
    expect((await tpl('quote_ready_doc')).status).toBe('PAUSED');
    const welcome = await tpl('welcome_first_touch');
    expect(welcome).toMatchObject({ category: 'UTILITY', intent: 'FIRST_TOUCH', variableMap: { body: { '1': 'lead.displayName', '2': 'ai.firstTouch' }, buttons: { '0': 'QUOTE', '1': 'STOP' } } });
    expect((welcome.categoryHistory as Array<{ category: string }>).map((c) => c.category)).toEqual(['MARKETING', 'UTILITY']);
    expect((await tpl('festive_offer_blast')).status).toBe('REJECTED');
    const last = (await h.db.auditEvent.findMany({ where: { action: 'integration.templates.sync' } })).find((a) => (a.summary as { missing?: number }).missing === 2)!;
    expect(last.summary).toMatchObject({ statusChanges: [{ name: 'quote_ready_doc', language: 'en', from: 'APPROVED', to: 'PAUSED' }] });
  });
});

describe('a paused template blocks the queued sends that use it', () => {
  it('TEMPLATE_NOT_APPROVED at preflight, no provider request; an approved one still passes', async () => {
    const lead = await liveLead(h);
    const owner = await h.owner();
    const paused = await tpl('quote_ready_doc');
    const approved = await tpl('welcome_first_touch');
    const eligibility = (templateId: string) =>
      checkDispatchEligibility(owner.db, owner, { leadId: lead.id, channel: 'WHATSAPP', kind: 'WA_TEMPLATE', templateId, sendIntent: 'MANUAL_SINGLE', initiatedBy: owner.actor!.userId }, { contactKeyPepper: PEPPER, externalOutboundPause: false });
    expect((await eligibility(paused.id)).reasons).toContain('TEMPLATE_NOT_APPROVED');
    expect((await eligibility(approved.id)).eligible).toBe(true);

    const q = await queueWhatsApp(h, owner, { leadId: lead.id, sendIntent: 'MANUAL_SINGLE', templateId: paused.id, variables: { '1': 'A', '2': 'Q-1' } });
    await h.drain();
    expect(await h.db.dispatchAttempt.findFirstOrThrow({ where: { messageId: q.messageId } })).toMatchObject({ state: 'SKIPPED', reasonCode: 'TEMPLATE_NOT_APPROVED' });
    expect(h.graph.requests.filter((r) => r.path.endsWith('/messages'))).toHaveLength(0);
  });
});

describe('scheduled sync', () => {
  it('a passing connection test arms wa.templateSync; the job applies the sync, and a failed fetch changes nothing', async () => {
    h.clock.advance(61_000);
    h.graph.on('GET', new RegExp(`^/v24\\.0/${PHONE_ID}$`), fixtureAnswer('response.phone-number.json'));
    h.graph.on('GET', new RegExp(`^/v24\\.0/${WABA_ID}$`), fixtureAnswer('response.waba.json'));
    const test = await testIntegrationConnection(await h.owner(), { kind: 'WHATSAPP_CLOUD' }, { testers: liveAdapters(h.deps()).testers });
    expect(test).toMatchObject({ outcome: 'TESTED', status: 'CONNECTED' });
    const jobs = await h.db.job.findMany({ where: { type: WA_TEMPLATE_SYNC_JOB } });
    expect(jobs.map((j) => j.idempotencyKey).sort()).toEqual([expect.stringMatching(/^wa\.templateSync:.+:2026-10-20T06$/), expect.stringMatching(/^wa\.templateSync:.+:2026-10-20T12$/)]);

    // The scheduled run fails (provider 5xx): templates stay as they were, the failure is audited.
    h.graph.on('GET', /\/message_templates$/, { status: 500, body: { error: { message: 'unavailable', code: 2 } } });
    h.graph.on('GET', new RegExp(`^/v24\\.0/${PHONE_ID}$`), fixtureAnswer('response.phone-number.json'));
    const before = await templates();
    await h.drain();
    expect(await templates()).toEqual(before);
    const failed = await h.db.auditEvent.findFirst({ where: { action: 'integration.templates.sync', result: 'FAILED' } });
    expect(failed?.summary).toMatchObject({ outcome: 'FAILED', errorCode: 'PROVIDER_UNAVAILABLE', trigger: 'scheduled' });
    // The next bucket is armed again.
    expect(await h.db.job.count({ where: { type: WA_TEMPLATE_SYNC_JOB, status: 'QUEUED' } })).toBeGreaterThanOrEqual(1);
  });
});
