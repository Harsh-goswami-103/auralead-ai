// T32 encrypted credential framework (plan §9 Credentials, A33, ADR-25, ADR-80; R38).
// - Writes: AES-256-GCM envelopes under the active kid with AAD workspaceId|integrationId|field;
//   masked reads only (last four for long values + time); re-entering rotates; revoke removes;
//   LIVE writes are CONFIGURED_UNVERIFIED and claim the routing key; DEMO stores demo_ placeholders
//   only and stays SIMULATED; audit rows name fields, never values; integrations.manage.
// - No reveal route or API exists anywhere; no app module decrypts.
// - An envelope copied to another row or field (AAD swap) does not decrypt.
// - `creds:rotate` re-encrypts integration secrets and webhook processing payloads under the
//   active kid and reports 0 remaining (and is idempotent), in-process and as the CLI.
// - LIVE decrypt failure: the send is skipped NOT_CONFIGURED, the integration says "Credential
//   unreadable, re-enter" (setup page, inbox, connection test), and no demo transport is reached.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as credentialsPOST } from '@/app/api/app/integrations/[kind]/credentials/route';
import { POST as revokePOST } from '@/app/api/app/integrations/[kind]/credentials/revoke/route';
import * as credentialsRoute from '@/app/api/app/integrations/[kind]/credentials/route';
import { DomainRuleError, PermissionDeniedError, ValidationError, ConflictError } from '@/lib/errors';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { ROUTES } from '@/server/routes.manifest';
import { credentialAad, decryptSecretString, encryptSecret, envelopeKid, SecretDecryptError, webhookPayloadAad, decryptSecret, type KeyRing } from '@/server/security/secrets';
import { getIntegrationSetup } from '@/server/services/integrations/center';
import { testIntegrationConnection } from '@/server/services/integrations/connection-test';
import { CREDENTIAL_UNREADABLE_MESSAGE, decryptIntegrationSecrets, revokeIntegrationCredentials, rotateCredentialEnvelopes, saveIntegrationCredentials } from '@/server/services/integrations/credentials';
import { liveAdapters } from '@/server/services/integrations/live-adapters';
import { getInboxThread } from '@/server/services/messaging/inbox';
import { createTestDb, type TestDb } from '../../support/db';
import { REPO_ROOT, spawnTsx, terminateAll } from '../../support/spawn';
import { makeRequest, testConfig, uninstallRuntime, useRuntime } from '../auth/support';
import { createIntegrationsHarness, employeeCtx, WS_A, WS_KESARI_SLUG, type IntegrationsHarness } from './support';
import { ACCESS_TOKEN, createLiveHarness, KEY_RING, liveLead, PEPPER, PHONE_ID, queueWhatsApp, SIMPLE_TEMPLATE, storeTemplate, storeWhatsApp, WABA_ID, type LiveHarness } from './live-support';

let live: LiveHarness;
let demo: IntegrationsHarness;

beforeAll(async () => {
  live = await createLiveHarness('t32-credentials');
  demo = await createIntegrationsHarness('t32-credentials-demo');
}, 180_000);
afterAll(async () => {
  uninstallRuntime();
  await terminateAll();
  await live?.destroy();
  await demo?.testDb.destroy();
});

const DEPS = { keyRing: KEY_RING };
const NEW_TOKEN = 'EAAGrotatedtokenYYYY000000000000000000000abcd';

describe('LIVE writes', () => {
  it('encrypts under the active kid with AAD workspaceId|integrationId|field and answers masked only', async () => {
    const result = await saveIntegrationCredentials(await live.owner(), { kind: 'WHATSAPP_CLOUD', config: { phoneNumberId: PHONE_ID, wabaId: WABA_ID }, credentials: { accessToken: ACCESS_TOKEN } }, DEPS);
    expect(result).toMatchObject({ kind: 'WHATSAPP_CLOUD', status: 'CONFIGURED_UNVERIFIED', simulated: false, saved: ['accessToken'], replaced: [] });
    expect(result.configChanged.sort()).toEqual(['phoneNumberId', 'wabaId']);
    expect(result.credentials).toEqual([{ field: 'accessToken', label: 'System user access token', saved: true, last4: 'wxyz', updatedAt: live.clock.now() }]);
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);

    const row = await live.db.integration.findUniqueOrThrow({ where: { id: result.integrationId } });
    const envelope = (row.secrets as Record<string, string>).accessToken!;
    expect(envelope).toMatch(/^v1\.k1\./);
    expect(envelopeKid(envelope)).toBe('k1');
    expect(decryptSecretString(KEY_RING, envelope, credentialAad({ workspaceId: live.workspaceId, integrationId: row.id, field: 'accessToken' }))).toBe(ACCESS_TOKEN);
    expect(row).toMatchObject({ status: 'CONFIGURED_UNVERIFIED', routingKey: PHONE_ID, verifiedAt: null, config: { phoneNumberId: PHONE_ID, wabaId: WABA_ID } });
    expect(row.secretLast4).toEqual({ accessToken: { last4: 'wxyz', updatedAt: live.clock.now().toISOString() } });

    const audit = await live.db.auditEvent.findFirstOrThrow({ where: { action: 'integration.credentials.set', targetId: row.id } });
    expect(audit.summary).toMatchObject({ kind: 'WHATSAPP_CLOUD', fields: ['accessToken'], rotated: [], status: 'CONFIGURED_UNVERIFIED' });
    expect(JSON.stringify(audit)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(audit)).not.toContain(envelope);
  });

  it('an envelope copied to another row or another field (AAD swap) does not decrypt', async () => {
    const wa = await live.db.integration.findFirstOrThrow({ where: { workspaceId: live.workspaceId, kind: 'WHATSAPP_CLOUD' } });
    const envelope = (wa.secrets as Record<string, string>).accessToken!;
    const other = await live.db.integration.create({ data: { workspaceId: live.workspaceId, kind: 'AI_ANTHROPIC', status: 'CONNECTED', config: {}, secrets: { apiKey: envelope } } });
    expect(() => decryptSecret(KEY_RING, envelope, credentialAad({ workspaceId: live.workspaceId, integrationId: other.id, field: 'apiKey' }))).toThrow(SecretDecryptError);
    expect(() => decryptSecret(KEY_RING, envelope, credentialAad({ workspaceId: live.workspaceId, integrationId: wa.id, field: 'wabaToken' }))).toThrow(/AUTH_FAILED/);
    expect(decryptIntegrationSecrets({ id: other.id, workspaceId: live.workspaceId, kind: 'AI_ANTHROPIC', secrets: other.secrets }, KEY_RING)).toEqual({ state: 'unreadable', field: 'apiKey' });
    await live.db.integration.delete({ where: { id: other.id } });
  });

  it('re-entering a credential rotates it: new envelope and last four, old value gone; an empty field keeps it', async () => {
    const before = await live.db.integration.findFirstOrThrow({ where: { workspaceId: live.workspaceId, kind: 'WHATSAPP_CLOUD' } });
    live.clock.advance(60_000);
    const result = await saveIntegrationCredentials(await live.owner(), { kind: 'WHATSAPP_CLOUD', credentials: { accessToken: NEW_TOKEN } }, DEPS);
    expect(result).toMatchObject({ saved: ['accessToken'], replaced: ['accessToken'], configChanged: [] });
    expect(result.credentials[0]).toMatchObject({ last4: 'abcd', updatedAt: live.clock.now() });
    const after = await live.db.integration.findUniqueOrThrow({ where: { id: before.id } });
    expect((after.secrets as Record<string, string>).accessToken).not.toBe((before.secrets as Record<string, string>).accessToken);
    expect(decryptIntegrationSecrets({ ...after, secrets: after.secrets }, KEY_RING)).toEqual({ state: 'ok', values: { accessToken: NEW_TOKEN } });

    const keep = await saveIntegrationCredentials(await live.owner(), { kind: 'WHATSAPP_CLOUD', config: { businessPortfolioId: '30987654321' }, credentials: { accessToken: '' } }, DEPS);
    expect(keep).toMatchObject({ saved: [], configChanged: ['businessPortfolioId'] });
    const kept = await live.db.integration.findUniqueOrThrow({ where: { id: before.id } });
    expect(kept.secrets).toEqual(after.secrets);
  });

  it('validates per catalog field; incomplete, empty, unknown and malformed input is refused without writing', async () => {
    const ctx = await live.owner();
    const count = await live.db.auditEvent.count();
    const err = (p: Promise<unknown>) => p.catch((e: unknown) => e);
    expect(await err(saveIntegrationCredentials(ctx, { kind: 'WHATSAPP_CLOUD', credentials: { accessToken: 'has spaces in it but long enough' } }, DEPS))).toMatchObject({ code: 'CREDENTIALS_INVALID', status: 400 });
    expect(await err(saveIntegrationCredentials(ctx, { kind: 'WHATSAPP_CLOUD', config: { phoneNumberId: '12ab' } }, DEPS))).toMatchObject({ code: 'CREDENTIALS_INVALID' });
    expect(await err(saveIntegrationCredentials(ctx, { kind: 'WHATSAPP_CLOUD', credentials: { password: 'x' } }, DEPS))).toMatchObject({ code: 'CREDENTIALS_INVALID' });
    expect(await err(saveIntegrationCredentials(ctx, { kind: 'WHATSAPP_CLOUD', config: { phoneNumberId: '' } }, DEPS))).toMatchObject({ code: 'CREDENTIALS_INVALID' });
    expect(await err(saveIntegrationCredentials(ctx, { kind: 'WHATSAPP_CLOUD' }, DEPS))).toBeInstanceOf(DomainRuleError);
    // A first write must make the integration complete.
    const incomplete = await err(saveIntegrationCredentials(ctx, { kind: 'AI_OPENAI', credentials: { apiKey: 'sk-proj-openai-test-key-000000000000' } }, DEPS));
    expect(incomplete).toBeInstanceOf(ValidationError);
    expect(incomplete).toMatchObject({ code: 'CREDENTIALS_INCOMPLETE' });
    expect(await live.db.integration.count({ where: { workspaceId: live.workspaceId, kind: 'AI_OPENAI' } })).toBe(0);
    expect(await live.db.auditEvent.count()).toBe(count);
  });

  it('keeps no last four of a short secret; needs integrations.manage; a taken phone number id is 409', async () => {
    const smtp = await saveIntegrationCredentials(await live.owner(), { kind: 'EMAIL_SMTP', config: { host: 'smtp.example.test', port: '587', username: 'quotes', fromAddress: 'quotes@example.test' }, credentials: { password: 'short pw 1' } }, DEPS);
    expect(smtp.credentials[0]).toMatchObject({ saved: true, last4: null, updatedAt: live.clock.now() });
    await expect(saveIntegrationCredentials(await live.member(), { kind: 'AI_ANTHROPIC', credentials: { apiKey: 'sk-ant-api03-member-0000000000000000' } }, DEPS)).rejects.toBeInstanceOf(PermissionDeniedError);

    const otherWs = await live.db.workspace.create({ data: { slug: 'other-live-co', name: 'Other Live Co', mode: 'LIVE', planLabel: 'Growth' } });
    await live.db.integration.create({ data: { workspaceId: otherWs.id, kind: 'META_ADS', status: 'CONNECTED', config: { pageId: '555555555' }, routingKey: '555555555' } });
    const taken = await saveIntegrationCredentials(await live.owner(), { kind: 'META_ADS', config: { pageId: '555555555' }, credentials: { accessToken: 'EAAGmetapagetoken000000000000000' } }, DEPS).catch((e: unknown) => e);
    expect(taken).toBeInstanceOf(ConflictError);
    expect(taken).toMatchObject({ code: 'ROUTING_KEY_TAKEN', status: 409 });
  });

  it('revoke removes every saved secret, sets REVOKED, keeps the routing key and is idempotent', async () => {
    const ctx = await live.owner();
    await saveIntegrationCredentials(ctx, { kind: 'AI_ANTHROPIC', credentials: { apiKey: 'sk-ant-api03-revoke-me-000000000000' } }, DEPS);
    const r1 = await revokeIntegrationCredentials(ctx, { kind: 'AI_ANTHROPIC' });
    expect(r1).toMatchObject({ status: 'REVOKED', revoked: ['apiKey'], changed: true });
    const row = await live.db.integration.findFirstOrThrow({ where: { workspaceId: live.workspaceId, kind: 'AI_ANTHROPIC' } });
    expect(row).toMatchObject({ status: 'REVOKED', secrets: null, secretLast4: null });
    expect(await revokeIntegrationCredentials(ctx, { kind: 'AI_ANTHROPIC' })).toMatchObject({ changed: false, revoked: [] });
    expect(await live.db.auditEvent.count({ where: { action: 'integration.credentials.revoke', targetId: row.id } })).toBe(1);
    await expect(revokeIntegrationCredentials(ctx, { kind: 'GOOGLE_SHEETS' })).rejects.toMatchObject({ code: 'NOTHING_TO_REVOKE' });
  });

  it('the setup read model is masked: no plaintext and no envelope anywhere in it', async () => {
    const setup = await getIntegrationSetup(await live.owner(), 'WHATSAPP_CLOUD');
    const json = JSON.stringify(setup);
    const row = await live.db.integration.findFirstOrThrow({ where: { workspaceId: live.workspaceId, kind: 'WHATSAPP_CLOUD' } });
    expect(json).not.toContain(NEW_TOKEN);
    expect(json).not.toContain((row.secrets as Record<string, string>).accessToken!);
    expect(setup.card.credentials).toEqual([expect.objectContaining({ saved: true, last4: 'abcd' })]);
  });
});

describe('DEMO writes', () => {
  it('store demo_ placeholders through the same path, stay SIMULATED and claim no routing key', async () => {
    const ctx = await employeeCtx(demo);
    const real = await saveIntegrationCredentials(ctx, { kind: 'WHATSAPP_CLOUD', config: { phoneNumberId: '1098765432', wabaId: '2098765432' }, credentials: { accessToken: 'EAAGrealtoken0000000000000000000000' } }, { keyRing: KEY_RING }).catch((e: unknown) => e);
    expect(real).toMatchObject({ code: 'CREDENTIALS_INVALID' });
    const res = await saveIntegrationCredentials(ctx, { kind: 'WHATSAPP_CLOUD', config: { phoneNumberId: '1098765432', wabaId: '2098765432' }, credentials: { accessToken: 'demo_token_smile_0001' } }, { keyRing: KEY_RING });
    expect(res).toMatchObject({ status: 'SIMULATED', simulated: true, saved: ['accessToken'] });
    const row = await demo.db.integration.findFirstOrThrow({ where: { workspaceId: WS_A, kind: 'WHATSAPP_CLOUD' } });
    expect(row).toMatchObject({ status: 'SIMULATED', routingKey: null });
    expect(await demo.db.auditEvent.findFirst({ where: { action: 'integration.credentials.set', targetId: row.id } })).toMatchObject({ simulated: true });
    await expect(saveIntegrationCredentials(await employeeCtx(demo, WS_KESARI_SLUG), { kind: 'WHATSAPP_CLOUD', credentials: { accessToken: 'demo_token_0002' } }, { keyRing: KEY_RING })).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('no reveal path', () => {
  const appDir = path.join(REPO_ROOT, 'src', 'app');
  function files(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) files(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  }

  it('no route reveals, decrypts or reads back a credential; the credential route has no GET', () => {
    const all = files(appDir);
    const routes = all.filter((f) => f.endsWith(`${path.sep}route.ts`)).map((f) => path.relative(REPO_ROOT, f).split(path.sep).join('/'));
    expect(routes.filter((r) => /reveal|decrypt|plaintext|unmask/i.test(r))).toEqual([]);
    for (const f of all) {
      const src = readFileSync(f, 'utf8');
      expect(src, path.relative(REPO_ROOT, f)).not.toMatch(/\b(decryptSecret|decryptSecretString|decryptIntegrationSecrets|loadIntegrationForUse)\b/);
    }
    expect('GET' in credentialsRoute).toBe(false);
    const entries = ROUTES.filter((r) => r.path.includes('/credentials'));
    expect(entries.map((e) => e.path).sort()).toEqual(['/api/app/integrations/[kind]/credentials', '/api/app/integrations/[kind]/credentials/revoke']);
    expect(entries.flatMap((e) => e.calls.map((c) => c.method))).toEqual(['POST', 'POST']);
  });
});

describe('routes over HTTP (LIVE runtime)', () => {
  it('answers masked, needs CSRF, and is rate limited per person and workspace', async () => {
    const runtime = useRuntime(live.db, testConfig('live'), live.clock);
    const { token, session } = await createSession(live.db, { userId: live.ownerId, globalRole: 'USER', mode: 'LIVE', activeWorkspaceId: live.workspaceId, ipHash: 'x', userAgent: 'vitest', now: live.clock.now() });
    const cookie = `${sessionCookieName(runtime.config)}=${token}`;
    const csrf = csrfTokenForSession(runtime.config, session.id);
    const params = { params: Promise.resolve({ kind: 'ai-anthropic' }) };
    const secret = 'sk-ant-api03-route-secret-PLAINTEXT-0001';
    const body = { workspaceSlug: live.slug, credentials: { apiKey: secret } };

    const noCsrf = await credentialsPOST(makeRequest('/api/app/integrations/ai-anthropic/credentials', { body, cookie }), params);
    expect(noCsrf.status).toBe(403);
    const ok = await credentialsPOST(makeRequest('/api/app/integrations/ai-anthropic/credentials', { body, cookie, csrf }), params);
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain('PLAINTEXT');
    expect(JSON.parse(text)).toMatchObject({ kind: 'AI_ANTHROPIC', status: 'CONFIGURED_UNVERIFIED', saved: ['apiKey'] });
    const rev = await revokePOST(makeRequest('/api/app/integrations/ai-anthropic/credentials/revoke', { body: { workspaceSlug: live.slug, confirm: 'REVOKE' }, cookie, csrf }), params);
    expect(rev.status).toBe(200);
    // inviteReset: 10 per hour per person and workspace (2 used above, the CSRF refusal counted too).
    const statuses: number[] = [];
    for (let i = 0; i < 9; i += 1) statuses.push((await credentialsPOST(makeRequest('/api/app/integrations/ai-anthropic/credentials', { body, cookie, csrf }), params)).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    expect(statuses.at(-1)).toBe(429);
    uninstallRuntime();
  });
});

describe('creds:rotate', () => {
  const OLD: KeyRing = { activeKid: 'k0', keys: { k0: Buffer.alloc(32, 3) } };
  const BOTH: KeyRing = { activeKid: 'k1', keys: { k0: Buffer.alloc(32, 3), k1: Buffer.alloc(32, 4) } };

  async function seedOld(db: LiveHarness['db'], workspaceId: string) {
    const row = await db.integration.create({ data: { workspaceId, kind: 'GOOGLE_SHEETS', status: 'CONNECTED', config: { sheetId: 'x'.repeat(30) } } });
    const json = JSON.stringify({ type: 'service_account', client_email: 'sa@example.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' });
    await db.integration.update({
      where: { id: row.id },
      data: {
        secrets: {
          serviceAccountJson: encryptSecret(OLD, json, credentialAad({ workspaceId, integrationId: row.id, field: 'serviceAccountJson' })),
          appsScriptSecret: encryptSecret(OLD, 's'.repeat(40), credentialAad({ workspaceId, integrationId: row.id, field: 'appsScriptSecret' })),
        },
      },
    });
    const event = await db.webhookEvent.create({ data: { workspaceId, provider: 'GOOGLE_SHEETS', scopeKey: workspaceId, externalKey: `evt-${row.id}`, bodySha256: 'a'.repeat(64), payloadRedacted: {}, receivedAt: new Date('2026-10-19T00:00:00.000Z') } });
    await db.webhookEvent.update({ where: { id: event.id }, data: { processingPayload: encryptSecret(OLD, '{"rows":[1]}', webhookPayloadAad(event.id)) } });
    return { row, event, json };
  }

  // A database of its own: every envelope in it is under the rings of this block.
  let rotDb: TestDb;
  let rotWs: string;
  beforeAll(async () => {
    rotDb = await createTestDb({ label: 't32-creds-rotate' });
    rotWs = (await rotDb.client().workspace.create({ data: { slug: 'rotate-in-process', name: 'Rotate', mode: 'LIVE', planLabel: 'Growth' } })).id;
  }, 120_000);
  afterAll(async () => {
    await rotDb?.destroy();
  });

  it('re-encrypts integration secrets and webhook processing payloads under the active kid, reports 0 remaining, and a second run changes nothing', async () => {
    const db = rotDb.client();
    const { row, event, json } = await seedOld(db, rotWs);
    const first = await rotateCredentialEnvelopes(db, BOTH, { clock: live.clock, correlationId: 'test-rotate' });
    expect(first.remainingOldKid).toBe(0);
    expect(first.unreadable).toEqual([]);
    expect(first.integrations.rotated).toBeGreaterThanOrEqual(2);
    expect(first.webhookEvents.rotated).toBe(1);
    const after = await db.integration.findUniqueOrThrow({ where: { id: row.id } });
    const secrets = after.secrets as Record<string, string>;
    expect(Object.values(secrets).every((e) => envelopeKid(e) === 'k1')).toBe(true);
    expect(decryptSecretString(BOTH, secrets.serviceAccountJson!, credentialAad({ workspaceId: rotWs, integrationId: row.id, field: 'serviceAccountJson' }))).toBe(json);
    const ev = await db.webhookEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(envelopeKid(ev.processingPayload!)).toBe('k1');
    expect(decryptSecretString(BOTH, ev.processingPayload!, webhookPayloadAad(event.id))).toBe('{"rows":[1]}');

    const second = await rotateCredentialEnvelopes(db, BOTH, { clock: live.clock, correlationId: 'test-rotate-2' });
    expect(second.unreadable).toEqual([]);
    expect(second).toMatchObject({ remainingOldKid: 0, integrations: expect.objectContaining({ rotated: 0 }), webhookEvents: expect.objectContaining({ rotated: 0 }) });
    const audits = await db.auditEvent.findMany({ where: { action: 'ops.creds_rotate', correlationId: { in: ['test-rotate', 'test-rotate-2'] } } });
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.result === 'SUCCESS' && a.workspaceId === null)).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(json);
  });

  it('an envelope no key in the ring can open is reported, left unchanged, and counted as remaining', async () => {
    const stray: KeyRing = { activeKid: 'k9', keys: { k9: Buffer.alloc(32, 9) } };
    const db = rotDb.client();
    const row = await db.integration.create({ data: { workspaceId: rotWs, kind: 'EMAIL_RESEND', status: 'CONNECTED', config: { fromDomain: 'example.test' } } });
    const envelope = encryptSecret(stray, 're_strayresendkey000000', credentialAad({ workspaceId: rotWs, integrationId: row.id, field: 'apiKey' }));
    await db.integration.update({ where: { id: row.id }, data: { secrets: { apiKey: envelope } } });
    const report = await rotateCredentialEnvelopes(db, BOTH, { clock: live.clock, correlationId: 'test-rotate-stray' });
    expect(report.unreadable).toEqual([{ table: 'Integration', id: row.id, field: 'apiKey', reason: 'UNKNOWN_KID' }]);
    expect(report.remainingOldKid).toBe(1);
    expect((await db.integration.findUniqueOrThrow({ where: { id: row.id } })).secrets).toEqual({ apiKey: envelope });
    expect((await db.auditEvent.findFirstOrThrow({ where: { action: 'ops.creds_rotate', correlationId: 'test-rotate-stray' } })).result).toBe('FAILED');
    await db.integration.delete({ where: { id: row.id } });
  });

  it('npm run creds:rotate (the script) reports 0 remaining and exits 0', async () => {
    let testDb: TestDb | null = null;
    try {
      testDb = await createTestDb({ label: 't32-creds-rotate-cli' });
      const db = testDb.client();
      const ws = await db.workspace.create({ data: { slug: 'rotate-cli', name: 'Rotate CLI', mode: 'LIVE', planLabel: 'Growth' } });
      await seedOld(db, ws.id);
      const keyring = JSON.stringify({ k0: BOTH.keys.k0!.toString('base64'), k1: BOTH.keys.k1!.toString('base64') });
      const secret = (s: string) => `${s}-${randomBytes(24).toString('hex')}`;
      const child = spawnTsx(path.join(REPO_ROOT, 'scripts', 'creds-rotate.ts'), {
        env: {
          APP_MODE: 'live',
          NEXT_PUBLIC_APP_MODE: 'live',
          DATABASE_URL: testDb.url,
          AURALEAD_DATA_DIR: path.join(testDb.dir, 'data'),
          SESSION_SECRET: secret('session'),
          SHARE_NONCE_KEY: secret('share'),
          SUPPRESSION_PEPPER: secret('pepper'),
          CREDENTIALS_KEYRING: keyring,
          CREDENTIALS_ACTIVE_KID: 'k1',
          AURALEAD_TEST_CONTROL: '0',
          LOG_LEVEL: 'silent',
        },
      });
      const exit = await child.waitForExit(90_000);
      const out = child.lines.join('\n');
      expect(exit.code, out + child.stderr()).toBe(0);
      expect(out).toContain('Remaining under other kids: 0');
      expect(out).not.toContain('PRIVATE KEY');
      const again = spawnTsx(path.join(REPO_ROOT, 'scripts', 'creds-rotate.ts'), { env: { APP_MODE: 'live', NEXT_PUBLIC_APP_MODE: 'live', DATABASE_URL: testDb.url, AURALEAD_DATA_DIR: path.join(testDb.dir, 'data'), SESSION_SECRET: secret('s'), SHARE_NONCE_KEY: secret('n'), SUPPRESSION_PEPPER: secret('p'), CREDENTIALS_KEYRING: keyring, CREDENTIALS_ACTIVE_KID: 'k1', AURALEAD_TEST_CONTROL: '0', LOG_LEVEL: 'silent' } });
      expect((await again.waitForExit(90_000)).code).toBe(0);
      expect(again.lines.join('\n')).toMatch(/2 envelopes in 1 integrations, 0 re-encrypted/);
      await db.$disconnect();
    } finally {
      await testDb?.destroy();
    }
  }, 180_000);
});

describe('LIVE decrypt failure', () => {
  it('skips the send NOT_CONFIGURED with "Credential unreadable, re-enter", never reaches a demo transport, and says so everywhere', async () => {
    live.graph.reset();
    // The token was encrypted under a key that is no longer in the ring.
    const gone: KeyRing = { activeKid: 'k7', keys: { k7: Buffer.alloc(32, 7) } };
    const wa = await storeWhatsApp(live, { status: 'CONNECTED', ring: gone });
    const template = await storeTemplate(live, { name: 'unreadable_case', components: SIMPLE_TEMPLATE });
    const lead = await liveLead(live);
    const owner = await live.owner();
    const q1 = await queueWhatsApp(live, owner, { leadId: lead.id, sendIntent: 'MANUAL_SINGLE', templateId: template.id, variables: { '1': 'A', '2': 'B' } });
    const q2 = await queueWhatsApp(live, owner, { leadId: lead.id, sendIntent: 'MANUAL_SINGLE', templateId: template.id, variables: { '1': 'C', '2': 'D' } });
    await live.drain();

    for (const q of [q1, q2]) {
      const attempt = await live.db.dispatchAttempt.findFirstOrThrow({ where: { messageId: q.messageId } });
      expect(attempt).toMatchObject({ state: 'SKIPPED', reasonCode: 'NOT_CONFIGURED' });
      expect(attempt.errorRedacted).toContain('CREDENTIAL_UNREADABLE');
    }
    expect(live.graph.requests).toHaveLength(0);
    expect(live.demoOutboxExists()).toBe(false);
    const row = await live.db.integration.findUniqueOrThrow({ where: { id: wa.id } });
    expect(row).toMatchObject({ status: 'ERROR', lastErrorCode: 'CREDENTIAL_UNREADABLE', lastErrorRedacted: CREDENTIAL_UNREADABLE_MESSAGE });
    expect(CREDENTIAL_UNREADABLE_MESSAGE).toBe('Credential unreadable, re-enter');
    expect(await live.db.auditEvent.count({ where: { action: 'integration.credentials.unreadable', targetId: wa.id } })).toBe(1);

    const setup = await getIntegrationSetup(owner, 'WHATSAPP_CLOUD');
    expect(setup.card.credentialProblem).toBe('Credential unreadable, re-enter');
    const thread = await getInboxThread(owner, q1.conversationId, { contactKeyPepper: PEPPER, externalOutboundPause: false });
    expect(thread.messages.find((m) => m.id === q1.messageId)!.note).toBe('Not sent: Credential unreadable, re-enter.');

    const test = await testIntegrationConnection(owner, { kind: 'WHATSAPP_CLOUD' }, { testers: liveAdapters(live.deps()).testers });
    expect(test).toMatchObject({ outcome: 'TESTED', status: 'ERROR', errorCode: 'CREDENTIAL_UNREADABLE' });
    expect(test.message).toContain('Credential unreadable, re-enter');
    expect(live.graph.requests).toHaveLength(0);

    // Re-entering it clears the problem (configured, not verified until the next test).
    await saveIntegrationCredentials(owner, { kind: 'WHATSAPP_CLOUD', credentials: { accessToken: ACCESS_TOKEN } }, DEPS);
    expect((await getIntegrationSetup(owner, 'WHATSAPP_CLOUD')).card.credentialProblem).toBeNull();
  });
});
