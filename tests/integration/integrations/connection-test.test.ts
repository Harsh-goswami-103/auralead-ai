// T28 "Test connection" (PRD: "Unavailable integration shows Not configured / Verification
// required with a working setup action. Never silently fall back to simulated success"; R1).
//  - DEMO never contacts a provider: the answer is "Simulated, no provider contacted", the stored
//    status never changes, a registered live tester is never called, and the check is audited as
//    simulated (lastCheckedAt is recorded on a stored row).
//  - LIVE without a stored, configured integration is 422 INTEGRATION_NOT_CONFIGURED.
//  - LIVE with no live tester registered for the kind (T32 registers them) reports Verification
//    required and never upgrades the status.
//  - LIVE with a registered tester persists its outcome (status, check time, redacted error,
//    verifiedAt only on CONNECTED): the seam T32 plugs into.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SIMULATED_TEST_LABEL } from '@/lib/domain/integrations';
import { DomainRuleError, PermissionDeniedError } from '@/lib/errors';
import { testIntegrationConnection } from '@/server/services/integrations/connection-test';
import type { LiveConnectionTester } from '@/server/services/integrations/types';
import { createIntegrationsHarness, employeeCtx, integrationWithSecrets, liveOwnerCtx, NOW, WS_A, WS_KESARI_SLUG, type IntegrationsHarness } from './support';

let h: IntegrationsHarness;
const NO_TESTERS = { testers: {} };

beforeAll(async () => {
  h = await createIntegrationsHarness('integration-connection-test');
}, 120_000);

afterAll(async () => {
  await h?.testDb.destroy();
});

const audits = (action = 'integration.test') => h.db.auditEvent.findMany({ where: { action }, orderBy: { createdAt: 'asc' } });

describe('DEMO', () => {
  it('a kind with nothing stored: simulated answer, status unchanged, no row created, audited as simulated', async () => {
    const tester = vi.fn<LiveConnectionTester>();
    const result = await testIntegrationConnection(await employeeCtx(h), { kind: 'AI_ANTHROPIC' }, { testers: { AI_ANTHROPIC: tester } });
    expect(result).toEqual({ outcome: 'SIMULATED', kind: 'AI_ANTHROPIC', status: 'NOT_CONFIGURED', message: SIMULATED_TEST_LABEL, checkedAt: new Date(NOW), errorCode: null });
    expect(tester).not.toHaveBeenCalled();
    expect(await h.db.integration.count({ where: { workspaceId: WS_A, kind: 'AI_ANTHROPIC' } })).toBe(0);
    const audit = (await audits()).at(-1)!;
    expect(audit).toMatchObject({ workspaceId: WS_A, simulated: true, result: 'SUCCESS', targetType: 'IntegrationKind', targetId: 'AI_ANTHROPIC' });
    expect(audit.summary).toMatchObject({ kind: 'AI_ANTHROPIC', outcome: 'SIMULATED' });
  });

  it('a stored SIMULATED row keeps its status and records the check time', async () => {
    const row = await h.db.integration.create({ data: { workspaceId: WS_A, kind: 'GOOGLE_SHEETS', status: 'SIMULATED', config: {} } });
    const result = await testIntegrationConnection(await employeeCtx(h), { kind: 'GOOGLE_SHEETS' }, NO_TESTERS);
    expect(result).toMatchObject({ outcome: 'SIMULATED', status: 'SIMULATED', message: SIMULATED_TEST_LABEL });
    const after = await h.db.integration.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ status: 'SIMULATED', lastCheckedAt: new Date(NOW), verifiedAt: null });
    expect((await audits()).at(-1)).toMatchObject({ targetType: 'Integration', targetId: row.id, simulated: true });
  });

  it('needs integrations.manage (403, nothing written)', async () => {
    const before = (await audits()).length;
    await expect(testIntegrationConnection(await employeeCtx(h, WS_KESARI_SLUG), { kind: 'WHATSAPP_CLOUD' }, NO_TESTERS)).rejects.toBeInstanceOf(PermissionDeniedError);
    expect((await audits()).length).toBe(before);
  });
});

describe('LIVE', () => {
  it('nothing stored: 422 INTEGRATION_NOT_CONFIGURED, nothing written, tester not called', async () => {
    const tester = vi.fn<LiveConnectionTester>();
    const before = (await audits()).length;
    const err = await testIntegrationConnection(await liveOwnerCtx(h), { kind: 'EMAIL_RESEND' }, { testers: { EMAIL_RESEND: tester } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainRuleError);
    expect(err).toMatchObject({ status: 422, code: 'INTEGRATION_NOT_CONFIGURED' });
    expect(tester).not.toHaveBeenCalled();
    expect((await audits()).length).toBe(before);
  });

  it('configured but no live tester registered: Verification required, never Connected', async () => {
    const row = await integrationWithSecrets(h.db, { workspaceId: h.liveWorkspaceId, kind: 'WHATSAPP_CLOUD', status: 'CONFIGURED_UNVERIFIED', config: { phoneNumberId: '1098765432' }, secrets: { accessToken: 'EAAG-token-1234' } });
    const result = await testIntegrationConnection(await liveOwnerCtx(h), { kind: 'WHATSAPP_CLOUD' }, NO_TESTERS);
    expect(result).toMatchObject({ outcome: 'VERIFICATION_REQUIRED', kind: 'WHATSAPP_CLOUD', status: 'CONFIGURED_UNVERIFIED' });
    expect(result.message).toMatch(/not been verified/i);
    const after = await h.db.integration.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ status: 'CONFIGURED_UNVERIFIED', verifiedAt: null, lastCheckedAt: null });
    expect((await audits()).at(-1)).toMatchObject({ targetId: row.id, result: 'FAILED', simulated: false });
  });

  it('a registered tester decides; its outcome is persisted with a redacted error', async () => {
    const row = await integrationWithSecrets(h.db, { workspaceId: h.liveWorkspaceId, kind: 'AI_ANTHROPIC', status: 'CONFIGURED_UNVERIFIED', config: { modelId: 'claude-opus-5-5' }, secrets: { apiKey: 'sk-ant-api-key-abcd' } });
    const failing = vi.fn<LiveConnectionTester>(async () => ({ status: 'ERROR', errorCode: 'PROVIDER_AUTH', errorMessage: 'Key rejected for ops@example.com from +919812345678' }));
    const failed = await testIntegrationConnection(await liveOwnerCtx(h), { kind: 'AI_ANTHROPIC' }, { testers: { AI_ANTHROPIC: failing } });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(failing.mock.calls[0]![1]).toMatchObject({ id: row.id, kind: 'AI_ANTHROPIC', status: 'CONFIGURED_UNVERIFIED', config: { modelId: 'claude-opus-5-5' } });
    expect(JSON.stringify(failing.mock.calls[0]![1])).not.toContain('v1.k1.');
    expect(failed).toMatchObject({ outcome: 'TESTED', status: 'ERROR', errorCode: 'PROVIDER_AUTH' });
    const stored = await h.db.integration.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored).toMatchObject({ status: 'ERROR', lastErrorCode: 'PROVIDER_AUTH', lastCheckedAt: new Date(NOW), verifiedAt: null });
    expect(stored.lastErrorRedacted).not.toContain('ops@example.com');
    expect(stored.lastErrorRedacted).not.toContain('9812345678');

    const passing = vi.fn<LiveConnectionTester>(async () => ({ status: 'CONNECTED' }));
    const ok = await testIntegrationConnection(await liveOwnerCtx(h), { kind: 'AI_ANTHROPIC' }, { testers: { AI_ANTHROPIC: passing } });
    expect(ok).toMatchObject({ outcome: 'TESTED', status: 'CONNECTED', errorCode: null });
    expect(await h.db.integration.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'CONNECTED', lastErrorCode: null, lastErrorRedacted: null, verifiedAt: new Date(NOW) });
  });

  it('a revoked integration must be reconnected first (422), whatever tester exists', async () => {
    await h.db.integration.create({ data: { workspaceId: h.liveWorkspaceId, kind: 'META_ADS', status: 'REVOKED', config: {} } });
    const tester = vi.fn<LiveConnectionTester>();
    await expect(testIntegrationConnection(await liveOwnerCtx(h), { kind: 'META_ADS' }, { testers: { META_ADS: tester } })).rejects.toMatchObject({ status: 422, code: 'INTEGRATION_NOT_CONFIGURED' });
    expect(tester).not.toHaveBeenCalled();
  });
});
