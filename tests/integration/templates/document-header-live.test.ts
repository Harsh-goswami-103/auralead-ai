// ADR-123 (slice F4, P1), LIVE through a scripted Graph transport (documented-shape fixtures;
// not live-verified): a template whose DOCUMENT header is the workspace's PDF brochure.
// - Submission needs the Meta app ID (WHATSAPP_CLOUD config `appId`) for the resumable upload:
//   without it 422 before anything changes. With it the job opens an upload session on the app,
//   uploads the bytes from offset 0, puts the returned handle in the header's `example.header_handle`
//   and only then creates the template; the handle is kept on the asset.
// - A failed upload creates nothing at Meta: back to DRAFT with the reason, no create request.
// - Sending: the brochure is uploaded per send to /<phoneNumberId>/media (like the quote PDF) and
//   referenced as the template's document header parameter.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@/lib/logger';
import { defaultButtons, type TemplateDraft } from '@/lib/domain/template-authoring';
import { createTemplateSubmitJob } from '@/server/jobs/handlers/template-submit';
import { buildJobRegistry } from '@/server/jobs/registry';
import { uploadMediaAsset } from '@/server/services/integrations/media-assets';
import { createTemplateDraft, submitTemplate } from '@/server/services/integrations/template-authoring';
import { createWorker, type Worker } from '../../../worker/worker';
import { fixtureAnswer } from '../contract/whatsapp-support';
import { ACCESS_TOKEN, createLiveHarness, liveLead, PHONE_ID, queueWhatsApp, storeWhatsApp, WABA_ID, type LiveHarness } from '../integrations/live-support';

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/whatsapp/template-admin');
const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
const statusOf = (name: string): number => (fixture('SOURCES.json') as { files: Record<string, { httpStatus: number }> }).files[name]!.httpStatus;
const answer = (name: string) => ({ status: statusOf(name), body: fixture(name) });

const APP_ID = '309876543210987';
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.from('Live brochure '.repeat(50), 'utf8')]);
const HANDLE = '4::YXBwbGljYXRpb24vcGRm:ARZbrochureSampleHandle0001';

let h: LiveHarness;
let submitWorker: Worker;
const drainSubmit = async () => {
  while ((await submitWorker.tick()) === 'ran');
};
const deps = () => ({ keyRing: h.flags.keyRing, graphVersion: h.flags.graphVersion, storageDir: h.storageDir, graph: { http: h.graph.http } });
let assetId: string;

beforeAll(async () => {
  h = await createLiveHarness('f4-document-header-live');
  await storeWhatsApp(h, { status: 'CONNECTED' });
  submitWorker = createWorker(
    { db: h.db, clock: h.clock, registry: buildJobRegistry([createTemplateSubmitJob({ deps: () => ({ ...deps(), mode: 'live' }) })]), logger: createLogger({ level: 'silent' }), mode: 'live', version: 'test', random: () => 0 },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
  assetId = (await uploadMediaAsset(await h.owner(), { fileName: 'brochure.pdf', contentType: 'application/pdf', dataBase64: PDF.toString('base64') }, { storageDir: h.storageDir })).id;
}, 120_000);
afterAll(async () => h?.destroy());
beforeEach(async () => {
  h.graph.reset();
  await h.db.job.updateMany({ where: { status: 'QUEUED', type: 'wa.templateSync' }, data: { status: 'CANCELLED' } });
});

let seq = 0;
function draft(): TemplateDraft {
  seq += 1;
  return {
    category: 'MARKETING',
    language: 'en',
    name: `live_brochure_${seq}`,
    utilityTrigger: null,
    header: { format: 'DOCUMENT', mediaId: assetId },
    body: 'Hello {{1}}, our website brochure is attached. Reply to know more.',
    variables: [{ position: '1', source: 'lead.firstName', example: 'Ravi' }],
    footer: 'Tap Stop to opt out',
    buttons: defaultButtons('MARKETING'),
  };
}

async function setAppId(appId: string | null) {
  const integration = await h.db.integration.findFirstOrThrow({ where: { workspaceId: h.workspaceId, kind: 'WHATSAPP_CLOUD' } });
  const config = { ...(integration.config as Record<string, string>) };
  if (appId) config.appId = appId;
  else delete config.appId;
  await h.db.integration.update({ where: { id: integration.id }, data: { config } });
}

describe('submission with a document header', () => {
  it('without the Meta app ID: 422 before anything changes', async () => {
    await setAppId(null);
    const ctx = await h.owner();
    const created = await createTemplateDraft(ctx, { draft: draft(), copyGeneratorLabel: null });
    await expect(submitTemplate(ctx, created.template.id, deps())).rejects.toMatchObject({ status: 422, code: 'INTEGRATION_NOT_CONFIGURED' });
    expect((await h.db.whatsAppTemplate.findUniqueOrThrow({ where: { id: created.template.id } })).status).toBe('DRAFT');
    expect(h.graph.requests).toHaveLength(0);
  });

  it('uploads the brochure (resumable upload on the app), then creates the template with the handle', async () => {
    await setAppId(APP_ID);
    const ctx = await h.owner();
    const created = await createTemplateDraft(ctx, { draft: draft(), copyGeneratorLabel: null });
    await submitTemplate(ctx, created.template.id, deps());
    h.graph
      .on('POST', new RegExp(`^/v24\\.0/${APP_ID}/uploads$`), answer('response.upload-session.json'))
      .on('POST', /^\/v24\.0\/upload:/, answer('response.upload-handle.json'))
      .on('POST', new RegExp(`^/v24\\.0/${WABA_ID}/message_templates$`), answer('response.template-create.json'));
    await drainSubmit();
    expect(h.graph.unexpected).toEqual([]);
    expect(h.graph.requests.map((r) => r.path)).toEqual([`/v24.0/${APP_ID}/uploads`, '/v24.0/upload:MTphdHRhY2htZW50OjEyMzQ1Njc4OTAxMjM0NTY3ODk=', `/v24.0/${WABA_ID}/message_templates`]);
    expect(h.graph.requests[1]!.raw?.equals(PDF)).toBe(true);
    for (const r of h.graph.requests) expect(r.url).not.toContain(ACCESS_TOKEN);
    const createBody = h.graph.requests[2]!.body as { components: Array<Record<string, unknown>> };
    expect(createBody.components[0]).toEqual({ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: [HANDLE] } });
    const row = await h.db.whatsAppTemplate.findUniqueOrThrow({ where: { id: created.template.id } });
    expect(row).toMatchObject({ status: 'PENDING', providerTemplateId: '594425479261596', headerMediaId: assetId });
    expect(await h.db.mediaAsset.findUniqueOrThrow({ where: { id: assetId } })).toMatchObject({ providerHandle: HANDLE, providerHandleAt: h.clock.now() });
  });

  it('a failed upload creates nothing: back to DRAFT with the reason, no create request', async () => {
    const ctx = await h.owner();
    const created = await createTemplateDraft(ctx, { draft: draft(), copyGeneratorLabel: null });
    await submitTemplate(ctx, created.template.id, deps());
    h.graph.on('POST', new RegExp(`^/v24\\.0/${APP_ID}/uploads$`), answer('error.template-auth.json'));
    await drainSubmit();
    expect(h.graph.requests.map((r) => r.path)).toEqual([`/v24.0/${APP_ID}/uploads`]);
    expect((await h.db.whatsAppTemplate.findUniqueOrThrow({ where: { id: created.template.id } })).status).toBe('DRAFT');
    const audits = await h.db.auditEvent.findMany({ where: { action: 'template.submit', targetId: created.template.id, result: 'FAILED' } });
    expect(audits.map((a) => (a.summary as { errorCode: string }).errorCode)).toEqual(['PROVIDER_AUTH']);
  });
});

describe('sending with the brochure as the document header', () => {
  it('uploads the brochure per send to /<phoneNumberId>/media and references it in the header', async () => {
    const ctx = await h.owner();
    const created = await createTemplateDraft(ctx, { draft: draft(), copyGeneratorLabel: null });
    await h.db.whatsAppTemplate.update({ where: { id: created.template.id }, data: { status: 'APPROVED' } });
    const lead = await liveLead(h);
    await queueWhatsApp(h, ctx, { leadId: lead.id, sendIntent: 'MANUAL_SINGLE', templateId: created.template.id, variables: { '1': 'Ravi' } });
    h.graph.on('POST', new RegExp(`^/v24\\.0/${PHONE_ID}/media$`), fixtureAnswer('response.media-upload.json')).on('POST', new RegExp(`^/v24\\.0/${PHONE_ID}/messages$`), fixtureAnswer('response.send-accepted.json'));
    await h.drain();
    expect(h.graph.unexpected).toEqual([]);
    const [upload, send] = h.graph.requests;
    expect(upload!.path).toBe(`/v24.0/${PHONE_ID}/media`);
    expect(upload!.raw!.includes(PDF)).toBe(true);
    expect(upload!.raw!.toString('latin1')).toContain('filename="brochure.pdf"');
    const body = send!.body as { template: { name: string; components: Array<Record<string, unknown>> } };
    expect(body.template.name).toBe(created.template.name);
    expect(body.template.components[0]).toEqual({ type: 'header', parameters: [{ type: 'document', document: { id: '1037543291543636', filename: 'brochure.pdf' } }] });
    expect(body.template.components[1]).toEqual({ type: 'body', parameters: [{ type: 'text', text: 'Ravi' }] });
    const attempt = await h.db.dispatchAttempt.findFirstOrThrow({ where: { message: { templateId: created.template.id } } });
    expect(attempt.state).toBe('SENT');
    expect(h.demoOutboxExists()).toBe(false);
  });
});
