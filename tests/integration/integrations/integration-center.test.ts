// T28 Integration center read model (PRD "Integration center: masked creds, connection tests, real
// status, template config, quality/limits, internal caps, AI/email setup"; plan §9 credentials
// "masked reads, no reveal"). One card per IntegrationKind in catalog order with the stored status
// (Not configured when no row exists, never an invented Connected), DEMO notes, internal caps
// labelled as internal, quality and limits as raw values or Unknown, and credentials only as
// "saved + last four": the encrypted envelope, the plaintext and the `secrets` key never leave the
// service. Reading needs `leads.read`; managing (`canManage`) needs `integrations.manage`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INTEGRATION_KIND_ORDER } from '@/lib/domain/integrations';
import { PermissionDeniedError } from '@/lib/errors';
import { getIntegrationCenter, getIntegrationSetup } from '@/server/services/integrations/center';
import { seedId } from '../../../prisma/seed/ids';
import { userCtx } from '../quotes/support';
import { createIntegrationsHarness, employeeCtx, integrationWithSecrets, liveOwnerCtx, nehaCtx, NOW as NOW_ISO, WS_A, WS_KESARI_SLUG, type IntegrationsHarness } from './support';

const SEED_ARJUN = seedId('user', 'arjun');
let h: IntegrationsHarness;

beforeAll(async () => {
  h = await createIntegrationsHarness('integration-center');
}, 120_000);

afterAll(async () => {
  await h?.testDb.destroy();
});

describe('Integration center (DEMO)', () => {
  it('lists every kind in catalog order, Not configured where nothing is stored, with the DEMO note', async () => {
    const center = await getIntegrationCenter(await employeeCtx(h));
    expect(center.mode).toBe('demo');
    expect(center.workspace).toMatchObject({ slug: 'smile-avenue-dental', name: 'Smile Avenue Dental Clinic' });
    expect(center.cards.map((c) => c.kind)).toEqual([...INTEGRATION_KIND_ORDER]);
    for (const card of center.cards) {
      expect(card.status).toBe('NOT_CONFIGURED');
      expect(card.stored).toBe(false);
      expect(card.simulated).toBe(true);
      expect(card.demoNote.length).toBeGreaterThan(20);
      expect(card.credentials.every((c) => c.saved === false && c.last4 === null)).toBe(true);
    }
    expect(center.canManage).toBe(true);
  });

  it('shows internal caps as internal and quality/limits as Unknown until a check stores raw values', async () => {
    const center = await getIntegrationCenter(await employeeCtx(h));
    const wa = center.cards.find((c) => c.kind === 'WHATSAPP_CLOUD')!;
    expect(wa.internalDailyCap).toBe(250);
    expect(wa.quality).toEqual({ qualityRaw: null, messagingLimitRaw: null, checkedAt: null, pausesAutomation: false });
    const resend = center.cards.find((c) => c.kind === 'EMAIL_RESEND')!;
    expect(resend.internalDailyCap).toBe(100);
    expect(resend.quality).toBeNull();
    expect(center.cards.find((c) => c.kind === 'AI_ANTHROPIC')!.internalDailyCap).toBeNull();
  });

  it('reads a stored SIMULATED integration with its raw quality values', async () => {
    await h.db.integration.create({ data: { workspaceId: WS_A, kind: 'GOOGLE_SHEETS', status: 'SIMULATED', config: { sheetId: 'demo-sheet-smile-avenue-dental' } } });
    await h.db.integration.create({ data: { workspaceId: WS_A, kind: 'WHATSAPP_CLOUD', status: 'SIMULATED', config: { phoneNumberId: `demo-${WS_A}` }, qualityRaw: 'GREEN', messagingLimitRaw: 'TIER_1K', limitsCheckedAt: new Date(NOW_ISO) } });
    const center = await getIntegrationCenter(await employeeCtx(h));
    const sheets = center.cards.find((c) => c.kind === 'GOOGLE_SHEETS')!;
    expect(sheets).toMatchObject({ status: 'SIMULATED', stored: true });
    expect(sheets.config).toEqual([
      { key: 'sheetId', label: 'Spreadsheet ID', value: 'demo-sheet-smile-avenue-dental' },
      { key: 'sheetName', label: 'Tab name', value: null },
    ]);
    const wa = center.cards.find((c) => c.kind === 'WHATSAPP_CLOUD')!;
    expect(wa.quality).toEqual({ qualityRaw: 'GREEN', messagingLimitRaw: 'TIER_1K', checkedAt: new Date(NOW_ISO), pausesAutomation: false });
  });

  it('a workspace where the assignment lacks integrations.manage reads the center but cannot manage', async () => {
    const center = await getIntegrationCenter(await employeeCtx(h, WS_KESARI_SLUG));
    expect(center.canManage).toBe(false);
    expect(center.cards).toHaveLength(7);
  });

  it('needs leads.read to read at all (403)', async () => {
    const pixel = await h.db.workspace.findUniqueOrThrow({ where: { slug: 'pixelchai-studio' } });
    await h.db.employeeAssignment.create({ data: { employeeUserId: SEED_ARJUN, workspaceId: pixel.id, capabilities: [], createdBy: SEED_ARJUN } });
    const ctx = await userCtx(h.db, h.clock, 'arjun', 'pixelchai-studio');
    await expect(getIntegrationCenter(ctx)).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(getIntegrationCenter(await nehaCtx(h))).resolves.toMatchObject({ canManage: false });
  });
});

describe('masked credentials', () => {
  it('returns saved + last four only: never the envelope, the plaintext or the secrets map', async () => {
    const ctx = await liveOwnerCtx(h);
    const token = 'EAAG-live-token-PLAIN-9xQz';
    const row = await integrationWithSecrets(h.db, { workspaceId: h.liveWorkspaceId, kind: 'WHATSAPP_CLOUD', status: 'CONFIGURED_UNVERIFIED', config: { phoneNumberId: '1098765432', wabaId: '2233445566' }, secrets: { accessToken: token } });
    const envelope = (row.secrets as Record<string, string>).accessToken!;

    const center = await getIntegrationCenter(ctx);
    const wa = center.cards.find((c) => c.kind === 'WHATSAPP_CLOUD')!;
    expect(wa.status).toBe('CONFIGURED_UNVERIFIED');
    expect(wa.simulated).toBe(false);
    expect(wa.credentials).toEqual([{ field: 'accessToken', label: 'System user access token', saved: true, last4: '9xQz', updatedAt: new Date(NOW_ISO) }]);
    expect(wa.config).toContainEqual({ key: 'phoneNumberId', label: 'Phone number ID', value: '1098765432' });

    const setup = await getIntegrationSetup(ctx, 'WHATSAPP_CLOUD');
    for (const view of [center, setup]) {
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain(envelope);
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain('PLAIN');
      expect(serialized).not.toMatch(/"secrets"/);
      expect(serialized).not.toMatch(/v1\.k1\./);
    }
  });

  it('a last-four value that is not four plain characters is never echoed', async () => {
    const ctx = await liveOwnerCtx(h);
    const row = await h.db.integration.create({ data: { workspaceId: h.liveWorkspaceId, kind: 'AI_OPENAI', status: 'CONFIGURED_UNVERIFIED', config: { modelId: 'gpt-test' } } });
    await h.db.integration.update({ where: { id: row.id }, data: { secrets: { apiKey: 'v1.k1.aaaa.bbbb.cccc' }, secretLast4: { apiKey: 'sk-proj-full-secret-value' } } });
    const card = (await getIntegrationCenter(ctx)).cards.find((c) => c.kind === 'AI_OPENAI')!;
    expect(card.credentials).toEqual([{ field: 'apiKey', label: 'API key', saved: true, last4: null, updatedAt: null }]);
    expect(JSON.stringify(card)).not.toContain('full-secret');
  });
});

describe('Integration center (LIVE)', () => {
  it('reports the stored truth with Live chips; nothing is simulated', async () => {
    const center = await getIntegrationCenter(await liveOwnerCtx(h));
    expect(center.mode).toBe('live');
    expect(center.canManage).toBe(true);
    for (const card of center.cards) expect(card.simulated).toBe(false);
    expect(center.cards.find((c) => c.kind === 'EMAIL_SMTP')!.status).toBe('NOT_CONFIGURED');
    expect(center.cards.find((c) => c.kind === 'WHATSAPP_CLOUD')!.internalDailyCap).toBe(250);
  });

  it('the setup view lists prerequisites, config, credentials, the webhook path and recent activity', async () => {
    const setup = await getIntegrationSetup(await liveOwnerCtx(h), 'WHATSAPP_CLOUD');
    expect(setup.card.kind).toBe('WHATSAPP_CLOUD');
    expect(setup.entry.prerequisites.length).toBeGreaterThan(2);
    expect(setup.webhookUrlPath).toBe('/api/webhooks/whatsapp');
    expect(setup.templates).toEqual([]);
    expect(Array.isArray(setup.activity)).toBe(true);
  });
});

