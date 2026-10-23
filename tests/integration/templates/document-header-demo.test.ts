// ADR-123 (slice F4, P1), DEMO: PDF brochures as a template's DOCUMENT header.
// - Upload (`templates.manage`): a PDF by type, name and magic bytes, at most 5 MB, stored at
//   STORAGE_DIR/media/<workspace>/<id>.pdf with its sha256 and size, audited `media.upload`
//   (size and hash prefix only); 413 too large, 422 not a PDF, 403 without the capability.
// - A draft's document header must be the workspace's own PDF (another workspace's asset 404).
// - DEMO submission: the simulated sample handle goes into the header example and on the asset;
//   a brochure file changed on disk is refused (422 MEDIA_MISSING); zero outbound.
// - Sending (the dispatch preflight and handler): the brochure is the document header, read and
//   checked against its hash, never the quote PDF; a changed file fails the send, never sends
//   something else.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultButtons, type TemplateDraft } from '@/lib/domain/template-authoring';
import { outboundAttempts, resetOutboundAttempts } from '@/server/adapters/http/outbound';
import { withTx } from '@/server/db/tx';
import { listMediaAssets, uploadMediaAsset } from '@/server/services/integrations/media-assets';
import { createTemplateDraft, getTemplateStudio, submitTemplate } from '@/server/services/integrations/template-authoring';
import { queueOutboundMessage } from '@/server/services/messaging/dispatch';
import { userCtx } from '../quotes/support';
import { createDispatchHarness, createLead, DEPS, grantConsent, WS_A, type DispatchHarness } from '../dispatch/support';
import { grantCapability, NOW } from './support';

let h: DispatchHarness;
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.from('Codecraft brochure body '.repeat(40), 'utf8')]);
const b64 = (bytes: Buffer) => bytes.toString('base64');

beforeAll(async () => {
  h = await createDispatchHarness('f4-document-header-demo');
  await grantCapability(h.db, 'employee', 'smile-avenue-dental', 'templates.manage');
  h.clock.set(NOW);
}, 120_000);
afterAll(async () => h?.destroy());
beforeEach(() => resetOutboundAttempts());

const operator = () => userCtx(h.db, h.clock, 'employee', 'smile-avenue-dental');
const studioDeps = () => ({ keyRing: null, graphVersion: null, storageDir: h.storageDir });

function brochureDraft(mediaId: string | null, name = 'website_brochure'): TemplateDraft {
  return {
    category: 'MARKETING',
    language: 'en',
    name,
    utilityTrigger: null,
    header: { format: 'DOCUMENT', mediaId },
    body: 'Hello {{1}}, our website brochure is attached. Reply to know more.',
    variables: [{ position: '1', source: 'lead.firstName', example: 'Ravi' }],
    footer: 'Tap Stop to opt out',
    buttons: defaultButtons('MARKETING'),
  };
}

describe('upload', () => {
  it('stores a PDF under media/<workspace>/<id>.pdf with its hash, audited without the file name', async () => {
    const asset = await uploadMediaAsset(await operator(), { fileName: 'Codecraft brochure.pdf', contentType: 'application/pdf', dataBase64: b64(PDF) }, { storageDir: h.storageDir });
    expect(asset).toMatchObject({ fileName: 'Codecraft brochure.pdf', byteSize: PDF.length });
    const row = await h.db.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row).toMatchObject({ workspaceId: WS_A, kind: 'DOCUMENT', mimeType: 'application/pdf', byteSize: PDF.length, storagePath: `media/${WS_A}/${asset.id}.pdf` });
    expect(fs.readFileSync(path.join(h.storageDir, row.storagePath)).equals(PDF)).toBe(true);
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'media.upload', targetId: asset.id } });
    expect(audit).toMatchObject({ simulated: true });
    expect(JSON.stringify(audit.summary)).not.toContain('brochure');
    expect(await listMediaAssets(await operator())).toEqual([asset]);
    expect((await getTemplateStudio(await operator(), { graphVersion: null })).media).toEqual([asset]);
  });

  it('refuses what is not a PDF of at most 5 MB, and needs templates.manage', async () => {
    const ctx = await operator();
    const before = await h.db.mediaAsset.count();
    const files = () => (fs.existsSync(path.join(h.storageDir, 'media', WS_A)) ? fs.readdirSync(path.join(h.storageDir, 'media', WS_A)).length : 0);
    const filesBefore = files();
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5 * 1024 * 1024)]);
    await expect(uploadMediaAsset(ctx, { fileName: 'big.pdf', contentType: 'application/pdf', dataBase64: b64(big) }, { storageDir: h.storageDir })).rejects.toMatchObject({ status: 413, code: 'MEDIA_TOO_LARGE' });
    await expect(uploadMediaAsset(ctx, { fileName: 'image.png', contentType: 'image/png', dataBase64: b64(PDF) }, { storageDir: h.storageDir })).rejects.toMatchObject({ status: 422, code: 'MEDIA_TYPE_UNSUPPORTED' });
    await expect(uploadMediaAsset(ctx, { fileName: 'fake.pdf', contentType: 'application/pdf', dataBase64: b64(Buffer.from('<html>not a pdf</html>')) }, { storageDir: h.storageDir })).rejects.toMatchObject({ status: 422, code: 'MEDIA_TYPE_MISMATCH' });
    await expect(uploadMediaAsset(ctx, { fileName: 'x.pdf', contentType: 'application/pdf', dataBase64: '###' }, { storageDir: h.storageDir })).rejects.toMatchObject({ status: 400 });
    await expect(uploadMediaAsset(await userCtx(h.db, h.clock, 'neha', 'ironpulse-fitness'), { fileName: 'b.pdf', contentType: 'application/pdf', dataBase64: b64(PDF) }, { storageDir: h.storageDir })).rejects.toMatchObject({ status: 403 });
    expect(await h.db.mediaAsset.count()).toBe(before);
    expect(files()).toBe(filesBefore);
  });
});

describe('document header drafts and DEMO submission', () => {
  it('a draft points at the workspace’s own PDF; another workspace’s asset is 404', async () => {
    const ctx = await operator();
    const [asset] = await listMediaAssets(ctx);
    const draft = await createTemplateDraft(ctx, { draft: brochureDraft(asset!.id), copyGeneratorLabel: null });
    expect(await h.db.whatsAppTemplate.findUniqueOrThrow({ where: { id: draft.template.id } })).toMatchObject({ headerMediaId: asset!.id });
    expect(draft.template.draft?.header).toEqual({ format: 'DOCUMENT', mediaId: asset!.id });
    const other = await h.db.mediaAsset.create({
      data: { workspaceId: (await h.db.workspace.findFirstOrThrow({ where: { slug: 'ironpulse-fitness' } })).id, kind: 'DOCUMENT', fileName: 'x.pdf', mimeType: 'application/pdf', byteSize: 1, sha256: 'x', storagePath: 'media/x/x.pdf', uploadedBy: 'u', createdAt: h.clock.now() },
    });
    await expect(createTemplateDraft(ctx, { draft: brochureDraft(other.id, 'foreign_brochure'), copyGeneratorLabel: null })).rejects.toMatchObject({ status: 404 });
    // Without a brochure the draft saves, but cannot be submitted.
    const empty = await createTemplateDraft(ctx, { draft: brochureDraft(null, 'brochure_later'), copyGeneratorLabel: null });
    await expect(submitTemplate(ctx, empty.template.id, studioDeps())).rejects.toMatchObject({ status: 422, code: 'TEMPLATE_INVALID' });
  });

  it('DEMO submission puts the simulated sample handle in the header example; a changed file is refused', async () => {
    const ctx = await operator();
    const tpl = await h.db.whatsAppTemplate.findFirstOrThrow({ where: { workspaceId: WS_A, name: 'website_brochure' } });
    await submitTemplate(ctx, tpl.id, studioDeps());
    const after = await h.db.whatsAppTemplate.findUniqueOrThrow({ where: { id: tpl.id } });
    const header = (after.components as Array<Record<string, unknown>>)[0]!;
    expect(header).toMatchObject({ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: [expect.stringMatching(/^demo-handle-[0-9a-f]{16}$/)] } });
    const asset = await h.db.mediaAsset.findUniqueOrThrow({ where: { id: tpl.headerMediaId! } });
    expect(asset).toMatchObject({ providerHandle: (header.example as { header_handle: string[] }).header_handle[0], providerHandleAt: h.clock.now() });
    expect(outboundAttempts()).toHaveLength(0);

    // The brochure changed on disk after upload: never submitted with something else.
    const second = await createTemplateDraft(ctx, { draft: brochureDraft(asset.id, 'website_brochure_two'), copyGeneratorLabel: null });
    const file = path.join(h.storageDir, asset.storagePath);
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.concat([original, Buffer.from('tampered')]));
    try {
      await expect(submitTemplate(ctx, second.template.id, studioDeps())).rejects.toMatchObject({ status: 422, code: 'MEDIA_MISSING' });
      expect((await h.db.whatsAppTemplate.findUniqueOrThrow({ where: { id: second.template.id } })).status).toBe('DRAFT');
    } finally {
      fs.writeFileSync(file, original);
    }
  });
});

describe('sending a template with its own brochure', () => {
  async function approvedBrochureTemplate(name: string) {
    const ctx = await operator();
    const [asset] = await listMediaAssets(ctx);
    const draft = await createTemplateDraft(ctx, { draft: brochureDraft(asset!.id, name), copyGeneratorLabel: null });
    await h.db.whatsAppTemplate.update({ where: { id: draft.template.id }, data: { status: 'APPROVED' } });
    return { templateId: draft.template.id, asset: asset! };
  }

  async function queue(templateId: string) {
    const lead = await createLead(h.db);
    await grantConsent(h.db, lead, 'WHATSAPP');
    const owner = await h.owner();
    return withTx(owner.db, (tx) =>
      queueOutboundMessage(tx, owner, { kind: 'TEMPLATE', templateId, variables: { '1': 'Ravi' }, leadId: lead.id, channel: 'WHATSAPP', sendIntent: 'MANUAL_SINGLE', initiatedBy: owner.actor!.userId, dedupeKey: `f4-brochure:${templateId}:${lead.id}` }, DEPS),
    );
  }

  it('the brochure is the document header, checked against its hash', async () => {
    const { templateId, asset } = await approvedBrochureTemplate('brochure_send_ok');
    await queue(templateId);
    const callsBefore = h.wa.calls.length;
    await h.drain();
    const call = h.wa.calls.at(-1)!;
    expect(h.wa.calls.length).toBe(callsBefore + 1);
    expect(call.request).toMatchObject({ kind: 'template', template: { name: 'brochure_send_ok', variables: { '1': 'Ravi' } } });
    expect(call.request.document).toMatchObject({ filename: asset.fileName, mimeType: 'application/pdf' });
    expect(call.request.document!.bytes.equals(PDF)).toBe(true);
    const attempt = await h.db.dispatchAttempt.findFirstOrThrow({ where: { message: { templateId } } });
    expect(attempt.state).toBe('SENT');
  });

  it('a brochure changed on disk fails the send (ARTIFACT_INTEGRITY); nothing else is sent', async () => {
    const { templateId, asset } = await approvedBrochureTemplate('brochure_send_tampered');
    const stored = await h.db.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    const file = path.join(h.storageDir, stored.storagePath);
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.from('%PDF-1.4 other'));
    try {
      await queue(templateId);
      const callsBefore = h.wa.calls.length;
      await h.drain();
      expect(h.wa.calls.length).toBe(callsBefore);
      const attempt = await h.db.dispatchAttempt.findFirstOrThrow({ where: { message: { templateId } } });
      expect(attempt).toMatchObject({ state: 'FAILED', reasonCode: 'ARTIFACT_INTEGRITY' });
    } finally {
      fs.writeFileSync(file, original);
    }
  });
});
