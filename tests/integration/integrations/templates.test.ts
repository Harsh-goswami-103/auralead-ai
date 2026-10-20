// T28 WhatsApp template sync (ADR-17: templates are synced and mapped, never authored in-app; DEMO
// has approved and rejected templates). In DEMO the sync is played by the demo adapter: it creates
// the workspace's SIMULATED WhatsApp integration when absent (no routing key, the inbox simulator's
// shape) and the demo templates that are absent, with raw provider status and category strings and
// their intents, never overwriting a stored template. After it, the approval queue offers WhatsApp
// for a quotation (the hand-over progress.md recorded as impossible in DEMO). LIVE needs a connected
// integration and the live sync T32 registers; nothing is ever invented there.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DomainRuleError, PermissionDeniedError } from '@/lib/errors';
import { DEMO_WHATSAPP_TEMPLATES, syncWhatsAppTemplates } from '@/server/services/integrations/templates';
import type { LiveTemplateSync } from '@/server/services/integrations/types';
import { getApprovalItem, listApprovalQueue } from '@/server/services/approvals/queue';
import { createDispatchHarness, DEPS, eligibleLead, quoteWithPdf, type DispatchHarness } from '../dispatch/support';
import { userCtx } from '../quotes/support';
import { createIntegrationsHarness, employeeCtx, liveOwnerCtx, WS_A, WS_KESARI_SLUG, type IntegrationsHarness } from './support';

let h: IntegrationsHarness;
const NO_LIVE = { liveSync: null };

beforeAll(async () => {
  h = await createIntegrationsHarness('integration-templates');
}, 120_000);

afterAll(async () => {
  await h?.testDb.destroy();
});

describe('DEMO template sync', () => {
  it('ships approved and rejected templates with raw strings and intents', () => {
    const statuses = DEMO_WHATSAPP_TEMPLATES.map((t) => t.status);
    expect(statuses).toContain('APPROVED');
    expect(statuses).toContain('REJECTED');
    expect(DEMO_WHATSAPP_TEMPLATES.find((t) => t.intent === 'QUOTE_READY')?.status).toBe('APPROVED');
    expect(DEMO_WHATSAPP_TEMPLATES.find((t) => t.intent === 'FIRST_TOUCH')?.status).toBe('APPROVED');
  });

  it('creates the simulated integration and every template when absent, audited as simulated', async () => {
    const result = await syncWhatsAppTemplates(await employeeCtx(h), NO_LIVE);
    expect(result).toMatchObject({ simulated: true, created: DEMO_WHATSAPP_TEMPLATES.length, existing: 0 });
    const integration = await h.db.integration.findFirstOrThrow({ where: { workspaceId: WS_A, kind: 'WHATSAPP_CLOUD' } });
    expect(integration).toMatchObject({ status: 'SIMULATED', routingKey: null, config: { phoneNumberId: `demo-${WS_A}` } });
    const rows = await h.db.whatsAppTemplate.findMany({ where: { workspaceId: WS_A }, orderBy: { name: 'asc' } });
    expect(rows.map((r) => `${r.name}:${r.language}:${r.status}`).sort()).toEqual(DEMO_WHATSAPP_TEMPLATES.map((t) => `${t.name}:${t.language}:${t.status}`).sort());
    for (const r of rows) {
      expect(r.integrationId).toBe(integration.id);
      expect(Array.isArray(r.categoryHistory)).toBe(true);
    }
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'integration.templates.sync', workspaceId: WS_A } });
    expect(audit).toMatchObject({ simulated: true, result: 'SUCCESS', targetId: integration.id });
    expect(audit.summary).toMatchObject({ created: DEMO_WHATSAPP_TEMPLATES.length, existing: 0 });
  });

  it('a second sync creates nothing and never overwrites a stored template', async () => {
    await h.db.whatsAppTemplate.updateMany({ where: { workspaceId: WS_A, intent: 'QUOTE_READY' }, data: { status: 'PAUSED' } });
    const again = await syncWhatsAppTemplates(await employeeCtx(h), NO_LIVE);
    expect(again).toMatchObject({ created: 0, existing: DEMO_WHATSAPP_TEMPLATES.length });
    expect((await h.db.whatsAppTemplate.findFirstOrThrow({ where: { workspaceId: WS_A, intent: 'QUOTE_READY' } })).status).toBe('PAUSED');
    expect(await h.db.integration.count({ where: { workspaceId: WS_A, kind: 'WHATSAPP_CLOUD' } })).toBe(1);
  });

  it('reuses the integration the inbox simulator created', async () => {
    const kesari = await h.db.workspace.findUniqueOrThrow({ where: { slug: WS_KESARI_SLUG } });
    const existing = await h.db.integration.create({ data: { workspaceId: kesari.id, kind: 'WHATSAPP_CLOUD', status: 'SIMULATED', config: { phoneNumberId: `demo-${kesari.id}` } } });
    // The Kesari owner holds integrations.manage (the employee there does not).
    const result = await syncWhatsAppTemplates(await userCtx(h.db, h.clock, 'vikram', WS_KESARI_SLUG), NO_LIVE);
    expect(result.integrationId).toBe(existing.id);
  });

  it('needs integrations.manage (403)', async () => {
    await expect(syncWhatsAppTemplates(await employeeCtx(h, WS_KESARI_SLUG), NO_LIVE)).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('LIVE template sync', () => {
  it('without a connected WhatsApp integration: 422, nothing created, the live sync is not called', async () => {
    const live = vi.fn<LiveTemplateSync>();
    const err = await syncWhatsAppTemplates(await liveOwnerCtx(h), { liveSync: live }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainRuleError);
    expect(err).toMatchObject({ status: 422, code: 'INTEGRATION_NOT_CONFIGURED' });
    expect(live).not.toHaveBeenCalled();
    expect(await h.db.whatsAppTemplate.count({ where: { workspaceId: h.liveWorkspaceId } })).toBe(0);
  });

  it('connected: the registered live sync runs; without one, the connection is reported unverified', async () => {
    await h.db.integration.create({ data: { workspaceId: h.liveWorkspaceId, kind: 'WHATSAPP_CLOUD', status: 'CONNECTED', config: { phoneNumberId: '1098765432' } } });
    await expect(syncWhatsAppTemplates(await liveOwnerCtx(h), NO_LIVE)).rejects.toMatchObject({ status: 422, code: 'INTEGRATION_NOT_VERIFIED' });
    const live = vi.fn<LiveTemplateSync>(async () => ({ integrationId: 'x', simulated: false, created: 2, existing: 1, updated: 0 }));
    const result = await syncWhatsAppTemplates(await liveOwnerCtx(h), { liveSync: live });
    expect(live).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ simulated: false, created: 2 });
  });
});

describe('after the DEMO sync, a quotation can be handed over on WhatsApp', () => {
  let d: DispatchHarness;
  beforeAll(async () => {
    d = await createDispatchHarness('integration-templates-handover');
  }, 120_000);
  afterAll(async () => {
    await d?.destroy();
  });

  it('the approval item offers WhatsApp with the synced approved templates only', async () => {
    const lead = await eligibleLead(d.db);
    const { quote } = await quoteWithPdf(d, lead.id);
    const ctx = await userCtx(d.db, d.clock, 'employee', 'smile-avenue-dental');
    const item = (await listApprovalQueue(ctx)).pending.find((i) => i.quote?.id === quote.id)!;
    const before = await getApprovalItem(ctx, item.id, { ...DEPS, externalOutboundPause: false });
    expect(before.channels.find((c) => c.channel === 'WHATSAPP')!.gate).toMatchObject({ category: 'configuration' });

    await syncWhatsAppTemplates(ctx, NO_LIVE);
    const after = await getApprovalItem(ctx, item.id, { ...DEPS, externalOutboundPause: false });
    const wa = after.channels.find((c) => c.channel === 'WHATSAPP')!;
    expect(wa.gate).toBeNull();
    const approved = DEMO_WHATSAPP_TEMPLATES.filter((t) => t.status === 'APPROVED').map((t) => t.name).sort();
    expect(wa.templates.map((t) => t.name).sort()).toEqual(approved);
  });
});
