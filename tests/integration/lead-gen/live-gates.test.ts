// Cross-slice (integrator): the LIVE gates of the lead-gen suite (plan R1, ADR-18, ADR-118,
// ADR-122..124). A LIVE workspace that has set up no Google Places, WhatsApp or AI integration gets
// configuration errors from every feature that would otherwise need a provider, through the
// services and through the routes the panels call, and never a simulated result in its place:
//  - starting a finder run: 422 PLACES_NOT_CONFIGURED; no run, no job, no result, no request;
//  - a WhatsApp template: no draft without the WhatsApp setup (422 INTEGRATION_NOT_CONFIGURED), and
//    a draft whose setup is gone is not submitted (422, audited DENIED, still a DRAFT, no job);
//  - "Generate with AI" copy: 422 AI_NOT_CONFIGURED, no model call, nothing stored;
//  - a handoff has no summary (NOT_CONFIGURED, no job) instead of a local one;
//  - a click-to-chat link needs the WhatsApp number (422 CLICK_TO_CHAT_NOT_CONFIGURED).
// At the end nothing in the database is marked simulated, and no provider saw a request.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST as generateRoute } from '@/app/api/app/templates/generate/route';
import { POST as createTemplateRoute } from '@/app/api/app/templates/route';
import { POST as submitTemplateRoute } from '@/app/api/app/templates/[templateId]/submit/route';
import { POST as finderStartRoute } from '@/app/api/app/finder/runs/route';
import { defaultButtons, type TemplateDraft } from '@/lib/domain/template-authoring';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import type { AppCtx } from '@/server/auth/context';
import { generateTemplateCopy } from '@/server/services/ai/template-copy';
import { createTemplateDraft, submitTemplate } from '@/server/services/integrations/template-authoring';
import { startFinderRun } from '@/server/services/lead-finder/runs';
import { StartFinderRunBody } from '@/server/services/lead-finder/schemas';
import { handOverLead } from '@/server/services/leads/handoff';
import { buildClickToChat } from '@/server/services/leads/reach-out';
import { makeRequest } from '../auth/support';
import { createLiveHarness, KEY_RING, type LiveHarness } from '../finder/support';
import type { RouteHandler } from './support';

let h: LiveHarness;
let owner: AppCtx;
const aiTransport = vi.fn(async () => {
  throw new Error('no AI provider may be called');
});
const ai = () => ({ keyRing: KEY_RING, transport: { fetch: aiTransport as never, timeoutMs: 1_000 } });
const studio = () => ({ keyRing: KEY_RING, graphVersion: null as string | null, storageDir: h.testDb.dir });

const DRAFT: TemplateDraft = {
  category: 'MARKETING',
  language: 'en',
  name: 'live_gate_intro',
  utilityTrigger: null,
  header: { format: 'NONE' },
  body: 'Hello {{1}}, we build fast websites for local businesses. Reply to know more.',
  variables: [{ position: '1', source: 'lead.firstName', example: 'Ravi' }],
  footer: null,
  buttons: defaultButtons('MARKETING'),
};

beforeAll(async () => {
  h = await createLiveHarness('lg-live-gates');
  owner = await h.owner();
}, 120_000);
afterAll(async () => h?.destroy());

async function liveCall(route: RouteHandler, url: string, body: unknown, params: Record<string, string> = {}) {
  const { token, session } = await createSession(h.db, { userId: h.ownerId, globalRole: 'USER', mode: 'LIVE', activeWorkspaceId: null, ipHash: 'lead-gen', userAgent: 'vitest', now: h.clock.now() });
  const res = await route(makeRequest(url, { body, cookie: `${sessionCookieName(h.config)}=${token}`, csrf: csrfTokenForSession(h.config, session.id) }), { params: Promise.resolve(params) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('LIVE with no Google Places, WhatsApp or AI integration', () => {
  it('starting a finder run is a configuration error, never the simulated directory', async () => {
    expect(await h.db.integration.count()).toBe(0);
    const body = StartFinderRunBody.parse({ requestKey: 'lg-live-run-0001', keywords: ['Dental clinic'], locations: ['Indore'], maxPerQuery: 20 });
    await expect(startFinderRun(owner, body, h.deps())).rejects.toMatchObject({ status: 422, code: 'PLACES_NOT_CONFIGURED' });
    const routed = await liveCall(finderStartRoute as RouteHandler, '/api/app/finder/runs', { requestKey: 'lg-live-run-0002', keywords: ['Dental clinic'], locations: ['Indore'], maxPerQuery: 20 });
    expect(routed).toMatchObject({ status: 422, body: { code: 'PLACES_NOT_CONFIGURED' } });
    expect(await h.db.leadFinderRun.count()).toBe(0);
    expect(await h.db.leadFinderResult.count()).toBe(0);
    expect(await h.db.job.count({ where: { type: { startsWith: 'leadFinder.' } } })).toBe(0);
    expect(h.graph.requests).toEqual([]);
  });

  it('a template cannot be drafted without the WhatsApp setup, and a draft whose setup is gone is not submitted', async () => {
    await expect(createTemplateDraft(owner, { draft: DRAFT, copyGeneratorLabel: null })).rejects.toMatchObject({ status: 422, code: 'INTEGRATION_NOT_CONFIGURED' });
    const routedDraft = await liveCall(createTemplateRoute as RouteHandler, '/api/app/templates', { ...DRAFT, header: { format: 'NONE' } });
    expect(routedDraft).toMatchObject({ status: 422, body: { code: 'INTEGRATION_NOT_CONFIGURED' } });
    expect(await h.db.whatsAppTemplate.count()).toBe(0);
    expect(await h.db.integration.count({ where: { status: 'SIMULATED' } })).toBe(0);

    // A draft saved while the WhatsApp setup was started; the setup is then not usable (no token).
    await h.db.integration.create({ data: { workspaceId: h.wsId, kind: 'WHATSAPP_CLOUD', status: 'NOT_CONFIGURED', config: {} } });
    const { template } = await createTemplateDraft(owner, { draft: DRAFT, copyGeneratorLabel: null });
    expect(template).toMatchObject({ status: 'DRAFT', simulated: false });

    await expect(submitTemplate(owner, template.id, studio())).rejects.toMatchObject({ status: 422, code: 'INTEGRATION_NOT_CONFIGURED' });
    const routedSubmit = await liveCall(submitTemplateRoute as RouteHandler, `/api/app/templates/${template.id}/submit`, {}, { templateId: template.id });
    expect(routedSubmit).toMatchObject({ status: 422, body: { code: 'INTEGRATION_NOT_CONFIGURED' } });
    expect(await h.db.whatsAppTemplate.findUniqueOrThrow({ where: { id: template.id } })).toMatchObject({ status: 'DRAFT', providerTemplateId: null, submittedAt: null });
    expect(await h.db.job.count({ where: { type: { in: ['wa.templateSubmit', 'wa.templateReview'] } } })).toBe(0);
    const denied = await h.db.auditEvent.findMany({ where: { action: 'template.submit', targetId: template.id } });
    expect(denied).toHaveLength(2);
    for (const row of denied) expect(row).toMatchObject({ result: 'DENIED', simulated: false, summary: { outcome: 'NOT_SUBMITTED', errorCode: 'INTEGRATION_NOT_CONFIGURED' } });
    expect(h.graph.requests).toEqual([]);
  });

  it('"Generate with AI" is a configuration error: no model call, nothing stored', async () => {
    const before = await h.db.whatsAppTemplate.count();
    await expect(generateTemplateCopy(owner, { category: 'MARKETING', language: 'en', utilityTrigger: null, purpose: 'Introduce our web design service' }, ai())).rejects.toMatchObject({ status: 422, code: 'AI_NOT_CONFIGURED' });
    const routed = await liveCall(generateRoute as RouteHandler, '/api/app/templates/generate', { category: 'UTILITY', utilityTrigger: 'MEETING_BOOKED' });
    expect(routed).toMatchObject({ status: 422, body: { code: 'AI_NOT_CONFIGURED' } });
    expect(await h.db.whatsAppTemplate.count()).toBe(before);
    expect(aiTransport).not.toHaveBeenCalled();
  });

  it('a handoff has no summary and queues no summary job; a click-to-chat link needs the WhatsApp number', async () => {
    const lead = await h.db.lead.create({
      data: { workspaceId: h.wsId, displayName: 'Live Gate Cafe', nameNormalized: 'live gate cafe', phoneE164: '+919822000001', alternatePhones: [], scoreReasons: [], unknownInputs: [], firstSource: 'MANUAL' },
    });
    const handed = await handOverLead(owner, { leadId: lead.id, note: 'Wants a menu site.', expectedStageVersion: lead.stageVersion, requestKey: 'lg-live-handoff-0001' }, ai());
    expect(handed).toMatchObject({ created: true, summaryStatus: 'NOT_CONFIGURED' });
    expect(await h.db.leadHandoff.findUniqueOrThrow({ where: { id: handed.handoffId } })).toMatchObject({ summaryStatus: 'NOT_CONFIGURED', summary: null, summaryGeneratorLabel: null });
    expect(await h.db.job.count({ where: { type: 'handoff.summary' } })).toBe(0);
    await expect(buildClickToChat(owner, { prefill: 'Hi, I saw your card' })).rejects.toMatchObject({ status: 422, code: 'CLICK_TO_CHAT_NOT_CONFIGURED' });
  });

  it('left nothing simulated behind and called no provider', async () => {
    expect(await h.db.auditEvent.count({ where: { simulated: true } })).toBe(0);
    expect(await h.db.integration.count({ where: { status: 'SIMULATED' } })).toBe(0);
    expect(await h.db.job.count({ where: { type: { in: ['leadFinder.search', 'leadFinder.emails', 'wa.templateSubmit', 'wa.templateReview', 'wa.demoStatus', 'handoff.summary', 'reply.auto'] } } })).toBe(0);
    expect(await h.db.message.count()).toBe(0);
    expect(h.graph.requests).toEqual([]);
    expect(aiTransport).not.toHaveBeenCalled();
  });
});
