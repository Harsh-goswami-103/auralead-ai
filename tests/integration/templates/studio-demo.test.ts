// ADR-123 (slice F4): the template studio in DEMO.
// - Drafts: origin AUTHORED, status DRAFT (never sendable), Meta's components with examples, the
//   mapping (body sources per position, the Stop button mapped to STOP), the UTILITY trigger, the
//   copy's generator; the SIMULATED WhatsApp integration is created when absent; rule errors are
//   422 TEMPLATE_INVALID, a taken name 409; only drafts can change; `templates.manage` (403) inside
//   the workspace, another workspace's template 404.
// - DEMO submission: PENDING with a simulated id, a `wa.templateReview` job 30 s later that approves
//   it, or rejects a name containing "reject" with a reason; audited simulated; zero outbound.
// - The studio read model and "Generate with AI" (DEMO: the labelled local template; the category
//   is the person's; Marketing gets the Stop button; Utility copy is not promotional).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { outboundAttempts, resetOutboundAttempts } from '@/server/adapters/http/outbound';
import { DEMO_REJECTION_REASON } from '@/server/adapters/whatsapp/template-admin-demo';
import { checkTemplateDraft, defaultButtons, templateComponentsOf, type TemplateDraft } from '@/lib/domain/template-authoring';
import { generateTemplateCopy } from '@/server/services/ai/template-copy';
import { createTemplateDraft, deleteTemplate, getTemplateStudio, submitTemplate, updateTemplateDraft } from '@/server/services/integrations/template-authoring';
import { checkDispatchEligibility } from '@/server/services/messaging/eligibility';
import { createLead, DEPS, grantConsent } from '../dispatch/support';
import { userCtx } from '../quotes/support';
import { createStudioHarness, WS_A, WS_KESARI_SLUG, type StudioHarness } from './support';

let h: StudioHarness;
const deps = () => ({ keyRing: null, graphVersion: null, storageDir: h.storageDir });

beforeAll(async () => {
  h = await createStudioHarness('f4-studio-demo');
}, 120_000);
afterAll(async () => h?.destroy());
beforeEach(() => resetOutboundAttempts());

function marketing(over: Partial<TemplateDraft> = {}): TemplateDraft {
  return {
    category: 'MARKETING',
    language: 'en',
    name: 'website_intro',
    utilityTrigger: null,
    header: { format: 'TEXT', text: 'A website for your business', example: null },
    body: 'Hello {{1}}, {{2}} builds fast websites for local businesses. Reply to see our work.',
    variables: [
      { position: '1', source: 'lead.firstName', example: 'Ravi' },
      { position: '2', source: 'workspace.name', example: 'Smile Avenue Dental' },
    ],
    footer: 'Tap Stop to opt out',
    buttons: defaultButtons('MARKETING'),
    ...over,
  };
}

const row = (id: string) => h.db.whatsAppTemplate.findUniqueOrThrow({ where: { id } });

describe('drafts', () => {
  it('saves a draft on the simulated WhatsApp integration (created when absent), never sendable', async () => {
    expect(await h.db.integration.count({ where: { workspaceId: WS_A, kind: 'WHATSAPP_CLOUD' } })).toBe(0);
    const ctx = await h.operator();
    const draft = marketing();
    const result = await createTemplateDraft(ctx, { draft, copyGeneratorLabel: 'local-deterministic' });
    expect(result.warnings).toEqual([]);
    expect(result.template).toMatchObject({ name: 'website_intro', status: 'DRAFT', origin: 'AUTHORED', simulated: true, editable: true, submittable: true, deletable: true, syncedAt: null });

    const stored = await row(result.template.id);
    expect(stored).toMatchObject({ origin: 'AUTHORED', status: 'DRAFT', category: 'MARKETING', language: 'en', syncedAt: null, providerTemplateId: null, copyGeneratorLabel: 'local-deterministic', utilityTrigger: null });
    expect(stored.components).toEqual(templateComponentsOf(draft));
    expect(stored.variableMap).toEqual({ body: { '1': 'lead.firstName', '2': 'workspace.name' }, buttons: { '0': 'STOP' } });
    const integration = await h.db.integration.findFirstOrThrow({ where: { workspaceId: WS_A, kind: 'WHATSAPP_CLOUD' } });
    expect(integration.status).toBe('SIMULATED');

    const audits = await h.db.auditEvent.findMany({ where: { workspaceId: WS_A, action: { in: ['integration.simulated.create', 'template.draft.create'] } }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => [a.action, a.simulated])).toEqual([
      ['integration.simulated.create', true],
      ['template.draft.create', true],
    ]);
    expect(audits[1]!.summary).toMatchObject({ template: 'website_intro', category: 'MARKETING', variables: 2, buttons: 1, generator: 'local-deterministic' });

    // A DRAFT is never sendable: the shared eligibility check refuses it for an opted-in lead.
    const lead = await createLead(h.db);
    await grantConsent(h.db, lead, 'WHATSAPP');
    const eligibility = await checkDispatchEligibility(ctx.db, ctx, { leadId: lead.id, channel: 'WHATSAPP', kind: 'WA_TEMPLATE', sendIntent: 'MANUAL_SINGLE', templateId: stored.id }, DEPS);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reasons).toContain('TEMPLATE_NOT_APPROVED');
    expect(outboundAttempts()).toHaveLength(0);
  });

  it('refuses rule errors (422 TEMPLATE_INVALID, issues named, nothing stored) and returns warnings', async () => {
    const ctx = await h.operator();
    const before = await h.db.whatsAppTemplate.count();
    const err = await createTemplateDraft(ctx, { draft: marketing({ name: 'Bad Name', body: 'Hi {{2}} there' }), copyGeneratorLabel: null }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422, code: 'TEMPLATE_INVALID' });
    expect((err as { safeDetails: { issues: Array<{ code: string }> } }).safeDetails.issues.map((i) => i.code)).toEqual(['NAME_FORMAT', 'BODY_VARIABLES_NOT_SEQUENTIAL']);
    expect(await h.db.whatsAppTemplate.count()).toBe(before);

    const noStop = await createTemplateDraft(ctx, { draft: marketing({ name: 'no_stop_button', buttons: [] }), copyGeneratorLabel: null });
    expect(noStop.warnings.map((w) => w.code)).toEqual(['NO_STOP_BUTTON']);
    const promo = await createTemplateDraft(ctx, {
      draft: marketing({ name: 'project_update', category: 'UTILITY', utilityTrigger: 'CUSTOMER_ASKED', buttons: [], body: 'Hello {{1}}, here is the launch offer you asked about from {{2}} today.' }),
      copyGeneratorLabel: null,
    });
    expect(promo.warnings.map((w) => w.code)).toEqual(['PROMOTIONAL_WORDS']);
    expect((await row(promo.template.id)).utilityTrigger).toBe('CUSTOMER_ASKED');
  });

  it('a name is unique per language (409 TEMPLATE_NAME_TAKEN); the same name in another language is fine', async () => {
    const ctx = await h.operator();
    await expect(createTemplateDraft(ctx, { draft: marketing(), copyGeneratorLabel: null })).rejects.toMatchObject({ status: 409, code: 'TEMPLATE_NAME_TAKEN' });
    const hindi = await createTemplateDraft(ctx, { draft: marketing({ language: 'hi' }), copyGeneratorLabel: null });
    expect(hindi.template.language).toBe('hi');
  });

  it('updates a draft; checks permission (403) and tenancy (404)', async () => {
    const ctx = await h.operator();
    const created = await createTemplateDraft(ctx, { draft: marketing({ name: 'editable_one' }), copyGeneratorLabel: null });
    const changed = await updateTemplateDraft(ctx, created.template.id, { draft: marketing({ name: 'editable_one', footer: null }), copyGeneratorLabel: null });
    expect(changed.template.draft?.footer).toBeNull();
    expect(await h.db.auditEvent.count({ where: { action: 'template.draft.update', targetId: created.template.id } })).toBe(1);
    await expect(updateTemplateDraft(ctx, created.template.id, { draft: marketing({ name: 'website_intro' }), copyGeneratorLabel: null })).rejects.toMatchObject({ status: 409, code: 'TEMPLATE_NAME_TAKEN' });

    await expect(createTemplateDraft(await h.neha(), { draft: marketing({ name: 'neha_try' }), copyGeneratorLabel: null })).rejects.toMatchObject({ status: 403 });
    // Kesari Crafts: the operator lacks templates.manage there.
    await expect(createTemplateDraft(await userCtx(h.db, h.clock, 'employee', WS_KESARI_SLUG), { draft: marketing({ name: 'kesari_try' }), copyGeneratorLabel: null })).rejects.toMatchObject({ status: 403 });
    // Another workspace's owner cannot see or change the draft.
    const other = await userCtx(h.db, h.clock, 'rohan');
    await expect(updateTemplateDraft(other, created.template.id, { draft: marketing({ name: 'editable_one' }), copyGeneratorLabel: null })).rejects.toMatchObject({ status: 404 });
    await expect(submitTemplate(other, created.template.id, deps())).rejects.toMatchObject({ status: 404 });
    await expect(deleteTemplate(other, created.template.id, deps())).rejects.toMatchObject({ status: 404 });
  });
});

describe('DEMO submission and simulated review', () => {
  it('needs the submission rules (examples) before it goes', async () => {
    const ctx = await h.operator();
    const created = await createTemplateDraft(ctx, { draft: marketing({ name: 'missing_examples', variables: [] }), copyGeneratorLabel: null });
    const err = await submitTemplate(ctx, created.template.id, deps()).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422, code: 'TEMPLATE_INVALID' });
    expect((await row(created.template.id)).status).toBe('DRAFT');
  });

  it('PENDING with a simulated id, approved by the review job 30 s later; audited simulated; nothing contacted', async () => {
    const ctx = await h.operator();
    const created = await createTemplateDraft(ctx, { draft: marketing({ name: 'website_launch_approve' }), copyGeneratorLabel: null });
    const submitted = await submitTemplate(ctx, created.template.id, deps());
    expect(submitted).toMatchObject({ simulated: true, reviewAt: new Date(h.clock.now().getTime() + 30_000).toISOString() });
    const pending = await row(created.template.id);
    expect(pending).toMatchObject({ status: 'PENDING', submittedBy: ctx.actor!.userId, submittedAt: h.clock.now() });
    expect(pending.providerTemplateId).toMatch(/^demo-tpl-[0-9a-f]{16}$/);
    const job = await h.db.job.findFirstOrThrow({ where: { type: 'wa.templateReview', payload: { equals: { templateId: created.template.id } } } });
    expect(job.runAt.toISOString()).toBe(submitted.reviewAt);
    expect(await h.db.job.count({ where: { type: 'wa.templateSubmit' } })).toBe(0);
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'template.submit', targetId: created.template.id } });
    expect(audit).toMatchObject({ simulated: true, result: 'SUCCESS' });
    expect(audit.summary).toMatchObject({ outcome: 'SUBMITTED', status: 'PENDING' });

    // Only drafts change: no edit or second submission while Meta (here: the simulation) reviews it.
    await expect(updateTemplateDraft(ctx, created.template.id, { draft: marketing({ name: 'website_launch_approve' }), copyGeneratorLabel: null })).rejects.toMatchObject({ status: 409, code: 'TEMPLATE_NOT_EDITABLE' });
    await expect(submitTemplate(ctx, created.template.id, deps())).rejects.toMatchObject({ status: 409, code: 'TEMPLATE_NOT_SUBMITTABLE' });
    await expect(deleteTemplate(ctx, created.template.id, deps())).rejects.toMatchObject({ status: 409, code: 'TEMPLATE_NOT_DELETABLE' });

    h.clock.advance(29_000);
    await h.drain();
    expect((await row(created.template.id)).status).toBe('PENDING');
    h.clock.advance(1_000);
    await h.drain();
    const approved = await row(created.template.id);
    expect(approved).toMatchObject({ status: 'APPROVED', rejectedReason: null, syncedAt: h.clock.now() });
    const review = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'template.review', targetId: created.template.id } });
    expect(review).toMatchObject({ simulated: true, result: 'SUCCESS' });
    expect(review.summary).toMatchObject({ outcome: 'APPROVED' });
    expect(outboundAttempts()).toHaveLength(0);

    // Approved now: an opted-in lead may receive it (the same eligibility check as every send).
    const lead = await createLead(h.db);
    await grantConsent(h.db, lead, 'WHATSAPP');
    const eligibility = await checkDispatchEligibility(ctx.db, ctx, { leadId: lead.id, channel: 'WHATSAPP', kind: 'WA_TEMPLATE', sendIntent: 'MANUAL_SINGLE', templateId: created.template.id }, DEPS);
    expect(eligibility.reasons).not.toContain('TEMPLATE_NOT_APPROVED');
  });

  it('rejects a name containing "reject" with a reason; a rejected template can be deleted (simulated)', async () => {
    const ctx = await h.operator();
    const created = await createTemplateDraft(ctx, { draft: marketing({ name: 'please_reject_me' }), copyGeneratorLabel: null });
    await submitTemplate(ctx, created.template.id, deps());
    h.clock.advance(30_000);
    await h.drain();
    expect(await row(created.template.id)).toMatchObject({ status: 'REJECTED', rejectedReason: DEMO_REJECTION_REASON });
    const studio = await getTemplateStudio(ctx, { graphVersion: null });
    expect(studio.templates.find((t) => t.id === created.template.id)).toMatchObject({ status: 'REJECTED', rejectedReason: DEMO_REJECTION_REASON, deletable: true, editable: false, submittable: false });

    await deleteTemplate(ctx, created.template.id, deps());
    expect(await h.db.whatsAppTemplate.count({ where: { id: created.template.id } })).toBe(0);
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'template.delete', targetId: created.template.id } });
    expect(audit).toMatchObject({ simulated: true });
    expect(audit.summary).toMatchObject({ status: 'REJECTED', atProvider: false });
    expect(outboundAttempts()).toHaveLength(0);
  });

  it('a draft is deleted locally', async () => {
    const ctx = await h.operator();
    const created = await createTemplateDraft(ctx, { draft: marketing({ name: 'throwaway_draft' }), copyGeneratorLabel: null });
    await expect(deleteTemplate(ctx, created.template.id, deps())).resolves.toEqual({ deleted: true, templateId: created.template.id });
    expect(await h.db.auditEvent.count({ where: { action: 'template.draft.delete', targetId: created.template.id } })).toBe(1);
  });
});

describe('read model', () => {
  it('lists authored templates first with their state, the DEMO capabilities and the permission', async () => {
    const ctx = await h.operator();
    const studio = await getTemplateStudio(ctx, { graphVersion: null });
    expect(studio).toMatchObject({ mode: 'demo', canManage: true, whatsapp: { canDraft: true, canSubmit: true, simulated: true, problem: null }, ai: { local: true, available: true } });
    expect(studio.templates.every((t) => t.origin === 'AUTHORED')).toBe(true);
    const intro = studio.templates.find((t) => t.name === 'website_intro' && t.language === 'en')!;
    expect(intro.draft).toEqual(marketing());
    expect(intro.lastSubmit).toBeNull();
    const approved = studio.templates.find((t) => t.name === 'website_launch_approve')!;
    expect(approved.lastSubmit).toMatchObject({ result: 'SUCCESS', outcome: 'SUBMITTED' });
    const neha = await getTemplateStudio(await h.neha(), { graphVersion: null });
    expect(neha.canManage).toBe(false);
  });
});

describe('Generate with AI (DEMO: the labelled local template)', () => {
  it('keeps the person’s category, adds the Stop button to Marketing, maps every variable and passes the rules', async () => {
    const ctx = await h.operator();
    const first = await generateTemplateCopy(ctx, { category: 'MARKETING', language: 'en', utilityTrigger: null, purpose: 'Businesses without a website' }, { keyRing: null });
    expect(first.generatorLabel).toBe('local-deterministic');
    expect(first.draft.category).toBe('MARKETING');
    expect(first.draft.buttons[0]).toEqual({ type: 'QUICK_REPLY', text: 'Stop', intent: 'STOP' });
    expect(first.draft.variables.length).toBeGreaterThan(0);
    expect(first.draft.variables.find((v) => v.source === 'workspace.name')?.example).toBe('Smile Avenue Dental Clinic');
    expect(checkTemplateDraft(first.draft, { forSubmit: true })).toMatchObject({ ok: true });
    const again = await generateTemplateCopy(ctx, { category: 'MARKETING', language: 'en', utilityTrigger: null, purpose: 'Businesses without a website' }, { keyRing: null });
    expect(again.draft).toEqual(first.draft);

    const brochure = await generateTemplateCopy(ctx, { category: 'MARKETING', language: 'en', utilityTrigger: null, purpose: 'share our brochure' }, { keyRing: null });
    expect(brochure.draft.name).toMatch(/^website_brochure_\d{3}$/);

    const utility = await generateTemplateCopy(ctx, { category: 'UTILITY', language: 'en', utilityTrigger: 'MEETING_BOOKED', purpose: '' }, { keyRing: null });
    expect(utility.draft).toMatchObject({ category: 'UTILITY', utilityTrigger: 'MEETING_BOOKED' });
    expect(utility.draft.buttons.some((b) => b.type === 'QUICK_REPLY' && b.intent === 'STOP')).toBe(false);
    expect(checkTemplateDraft(utility.draft, { forSubmit: true })).toMatchObject({ ok: true, warnings: [] });
    expect(outboundAttempts()).toHaveLength(0);
    await expect(generateTemplateCopy(await h.neha(), { category: 'UTILITY', language: 'en', utilityTrigger: 'MEETING_BOOKED', purpose: '' }, { keyRing: null })).rejects.toMatchObject({ status: 403 });
  });
});
