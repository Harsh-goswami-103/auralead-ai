// ADR-123 (slice F4): per-lead template variables in bulk sends.
// - Body positions mapped to a lead or business source are filled for each lead
//   (`resolveLeadTemplateVariables`): "Hello {{1}}" carries each lead's own first name; positions
//   mapped to `manual` take the typed value, the same for every row.
// - A lead without a value for a mapped position (a business-style name has no first name) is a
//   FAILED row TEMPLATE_VARIABLE_MISSING in the pre-flight and the run: never sent with a gap.
// - An operator's run leaves out a lead handed over to the client (FAILED HANDED_OVER, ADR-124).
// - The run keeps the typed values as its params: a repeated request with the same key and the
//   same typed values is the same run.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { createBulkRunJob } from '@/server/jobs/handlers/bulk-run';
import { getBulkRun, previewBulkAction, requestBulkRun } from '@/server/services/bulk/bulk';
import { userCtx } from '../quotes/support';
import { createDispatchHarness, DEPS, grantConsent, WS_A, type DispatchHarness } from '../dispatch/support';

let h: DispatchHarness;

beforeAll(async () => {
  h = await createDispatchHarness('f4-bulk-variables', () => [createBulkRunJob({ deps: () => DEPS, mode: () => 'demo' })]);
}, 120_000);
afterAll(async () => h?.destroy());

let seq = 0;
async function lead(db: PrismaClient, displayName: string, extra: { city?: string | null; handedOver?: boolean } = {}) {
  seq += 1;
  const row = await db.lead.create({
    data: {
      workspaceId: WS_A,
      displayName,
      nameNormalized: displayName.toLowerCase(),
      phoneE164: `+9197777${String(seq).padStart(5, '0')}`,
      city: extra.city ?? null,
      alternatePhones: [],
      scoreReasons: [],
      unknownInputs: [],
      firstSource: 'MANUAL',
      ...(extra.handedOver ? { handedOverAt: new Date('2026-10-15T00:00:00.000Z') } : {}),
    },
  });
  await grantConsent(db, row, 'WHATSAPP');
  return row;
}

async function template(db: PrismaClient) {
  const integration =
    (await db.integration.findFirst({ where: { workspaceId: WS_A, kind: 'WHATSAPP_CLOUD' } })) ??
    (await db.integration.create({ data: { workspaceId: WS_A, kind: 'WHATSAPP_CLOUD', status: 'SIMULATED', config: {} } }));
  return db.whatsAppTemplate.create({
    data: {
      workspaceId: WS_A,
      integrationId: integration.id,
      name: 'website_intro_bulk',
      language: 'en',
      category: 'MARKETING',
      status: 'APPROVED',
      origin: 'AUTHORED',
      components: [{ type: 'BODY', text: 'Hello {{1}}, {{2}} builds websites for businesses in {{3}} like yours about {{4}} today.' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Stop' }] }],
      variableSchema: [],
      variableMap: { body: { '1': 'lead.firstName', '2': 'workspace.name', '3': 'lead.city', '4': 'manual' }, buttons: { '0': 'STOP' } },
      categoryHistory: [],
      syncedAt: new Date('2026-10-15T00:00:00.000Z'),
    },
  });
}

describe('bulk template send with per-lead variables (ADR-123)', () => {
  it('fills each lead’s own values, takes the typed value for manual positions, fails rows it cannot fill', async () => {
    const t = await template(h.db);
    const ravi = await lead(h.db, 'Mr. Ravi Kumar', { city: 'Indore' });
    const priya = await lead(h.db, 'Priya Shah', { city: 'Bhopal' });
    const bakery = await lead(h.db, 'The Bake House', { city: 'Indore' });
    const noCity = await lead(h.db, 'Arjun Mehta', { city: null });
    const handed = await lead(h.db, 'Neha Joshi', { city: 'Indore', handedOver: true });
    const operator = await userCtx(h.db, h.clock, 'employee', 'smile-avenue-dental');
    const input = { action: 'SEND_WHATSAPP_TEMPLATE' as const, templateId: t.id, variables: { '4': 'a new website', '1': 'ignored for mapped positions' }, leadIds: [ravi.id, priya.id, bakery.id, noCity.id, handed.id] };

    const preview = await previewBulkAction(operator, input, DEPS);
    expect(preview).toMatchObject({ selected: 5, eligible: 2, skipped: 0, failed: 3 });
    const byLead = Object.fromEntries(preview.rows.map((r) => [r.leadId, r]));
    expect(byLead[bakery.id]).toMatchObject({ outcome: 'FAILED', reasons: ['TEMPLATE_VARIABLE_MISSING'] });
    expect(byLead[noCity.id]).toMatchObject({ outcome: 'FAILED', reasons: ['TEMPLATE_VARIABLE_MISSING'] });
    expect(byLead[handed.id]).toMatchObject({ outcome: 'FAILED', reasons: ['HANDED_OVER'] });
    expect(preview.byReason).toEqual(expect.arrayContaining([{ code: 'TEMPLATE_VARIABLE_MISSING', label: 'A template variable has no value for this lead', count: 2 }]));

    const run = await requestBulkRun(operator, { ...input, requestKey: 'bulk-vars-0001' }, DEPS);
    expect((await requestBulkRun(operator, { ...input, requestKey: 'bulk-vars-0001' }, DEPS)).id).toBe(run.id);
    const stored = await h.db.bulkRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.params).toEqual({ action: 'SEND_WHATSAPP_TEMPLATE', templateId: t.id, variables: { '4': 'a new website', '1': 'ignored for mapped positions' } });
    await h.drain();

    expect(await getBulkRun(operator, run.id)).toMatchObject({ status: 'COMPLETED', queued: 2, skipped: 0, failed: 3 });
    const messages = await h.db.message.findMany({ where: { workspaceId: WS_A, templateId: t.id }, include: { conversation: true } });
    const byLeadVars = Object.fromEntries(messages.map((m) => [m.conversation.leadId, m.variables]));
    expect(byLeadVars[ravi.id]).toEqual({ '1': 'Ravi', '2': 'Smile Avenue Dental Clinic', '3': 'Indore', '4': 'a new website' });
    expect(byLeadVars[priya.id]).toEqual({ '1': 'Priya', '2': 'Smile Avenue Dental Clinic', '3': 'Bhopal', '4': 'a new website' });
    expect(Object.keys(byLeadVars).sort()).toEqual([ravi.id, priya.id].sort());
    const sent = h.wa.calls.filter((c) => c.request.template?.name === 'website_intro_bulk').map((c) => c.request.template!.variables['1']);
    expect(sent.sort()).toEqual(['Priya', 'Ravi']);
  });

  it('a typed value missing for a manual position fails every row (nothing queued)', async () => {
    const t = await h.db.whatsAppTemplate.findFirstOrThrow({ where: { workspaceId: WS_A, name: 'website_intro_bulk' } });
    const one = await lead(h.db, 'Kabir Rao', { city: 'Indore' });
    const preview = await previewBulkAction(await h.owner(), { action: 'SEND_WHATSAPP_TEMPLATE', templateId: t.id, variables: {}, leadIds: [one.id] }, DEPS);
    expect(preview).toMatchObject({ eligible: 0, failed: 1, rows: [{ outcome: 'FAILED', reasons: ['TEMPLATE_VARIABLE_MISSING'] }] });
  });
});
