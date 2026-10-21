/**
 * T36 Extension hub: token management routes and the hub read model (PRD "Extension hub (scoped
 * keys, revocation, webhook config, batch status, errors, simulation)", plan §9 Extension).
 *  - POST /api/app/extension/tokens issues `alx_<keyId>_<secret>` once: only the secret's sha256 is
 *    stored, the audit names the prefix and never the secret, at most 10 active tokens per
 *    workspace, `extension.manage` in the named workspace (403 without it, 404 outside it).
 *  - POST .../[tokenId]/revoke needs the typed confirmation `REVOKE`; a repeat is idempotent.
 *  - POST .../[tokenId]/allowed-extension sets or clears the Chrome extension id CORS answers for.
 *  - The hub shows the webhook URL, tokens by prefix and state, each batch with its per-record
 *    failures (intake and ingestion), and refused token uses with their reason; never a secret.
 */
import { createHash } from 'node:crypto';
import { createElement, type FC, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import ExtensionPage from '@/app/dashboard/employee/[ws]/extension/page';
import { POST as createRoute } from '@/app/api/app/extension/tokens/route';
import { POST as revokeRoute } from '@/app/api/app/extension/tokens/[tokenId]/revoke/route';
import { POST as allowedRoute } from '@/app/api/app/extension/tokens/[tokenId]/allowed-extension/route';
import { getExtensionHubDetails } from '@/server/services/extension/hub';
import { makeRequest } from '../auth/support';
import { sessionFor, type Auth } from '../webhooks/support';
import {
  batchBody,
  createExtensionHarness,
  EXTENSION_ID,
  issueToken,
  managerCtx,
  mapsRecord,
  postBatch,
  WS_A,
  WS_A_SLUG,
  WS_KESARI_SLUG,
  type ExtensionHarness,
} from '../webhooks/extension-support';

const pageHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => pageHeaders.current }));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/dashboard/employee/smile-avenue-dental/extension',
}));

let h: ExtensionHarness;
let employee: Auth;
beforeAll(async () => {
  h = await createExtensionHarness('extension-token-routes');
  employee = await sessionFor(h, 'employee');
}, 120_000);
afterAll(async () => h?.destroy());

type Call = { status: number; body: Record<string, unknown>; headers: Headers };

async function call(route: typeof createRoute, path: string, body: unknown, auth: Auth | null, params: Record<string, string> = {}): Promise<Call> {
  // The routes share the 10-per-hour secret-handling limit; one token refills every 6 minutes.
  h.clock.advance(6 * 60_000);
  const req = makeRequest(path, { body, cookie: auth?.cookie ?? null, csrf: auth?.csrf ?? null });
  const res = await route(req, { params: Promise.resolve(params) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

const create = (body: Record<string, unknown>, auth: Auth | null = employee) => call(createRoute, '/api/app/extension/tokens', body, auth);
const revoke = (tokenId: string, body: Record<string, unknown>, auth: Auth | null = employee) =>
  call(revokeRoute, `/api/app/extension/tokens/${tokenId}/revoke`, body, auth, { tokenId });
const setAllowed = (tokenId: string, body: Record<string, unknown>, auth: Auth | null = employee) =>
  call(allowedRoute, `/api/app/extension/tokens/${tokenId}/allowed-extension`, body, auth, { tokenId });

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('POST /api/app/extension/tokens', () => {
  it('issues the token once: alx_ shape, sha256-only storage, audited without the secret, no-store', async () => {
    const res = await create({ workspaceSlug: WS_A_SLUG, name: 'Front desk laptop', allowedExtensionId: EXTENSION_ID, expiresInDays: 90 });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const token = res.body.token as string;
    expect(token).toMatch(/^alx_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    const prefix = res.body.prefix as string;
    expect(token.startsWith(`${prefix}_`)).toBe(true);
    const secret = token.slice(prefix.length + 1);
    expect(res.body).toMatchObject({ name: 'Front desk laptop', scopes: ['ingest:gmaps'], allowedExtensionId: EXTENSION_ID });
    expect(new Date(res.body.expiresAt as string).getTime()).toBe(h.clock.now().getTime() + 90 * 86_400_000);

    const row = await h.db.extensionToken.findUniqueOrThrow({ where: { prefix } });
    expect(row).toMatchObject({ workspaceId: WS_A, secretHash: sha256(secret), revokedAt: null });
    expect(JSON.stringify(row)).not.toContain(secret);

    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'extension.token.create', targetId: row.id } });
    expect(audit.summary).toMatchObject({ prefix, allowedExtension: true, expiresInDays: 90 });
    expect(JSON.stringify(audit)).not.toContain(secret);

    // The hub lists it by prefix only.
    const hub = await getExtensionHubDetails(await managerCtx(h), { appOrigin: h.config.appOrigin });
    expect(hub.tokens.find((t) => t.prefix === prefix)).toMatchObject({ name: 'Front desk laptop', state: 'ACTIVE', allowedExtensionId: EXTENSION_ID });
    expect(JSON.stringify(hub)).not.toContain(secret);
    expect(JSON.stringify(hub)).not.toContain(row.secretHash);
  });

  it('validates the body: a name is required, the extension id is 32 letters a-p, expiry is 30, 90 or 365 days', async () => {
    expect((await create({ workspaceSlug: WS_A_SLUG, name: '  ' })).status).toBe(400);
    expect((await create({ workspaceSlug: WS_A_SLUG, name: 'x', allowedExtensionId: 'chrome-extension://abc' })).status).toBe(400);
    expect((await create({ workspaceSlug: WS_A_SLUG, name: 'x', expiresInDays: 7 })).status).toBe(400);
  });

  it('caps a workspace at 10 active tokens; revoked tokens do not count', async () => {
    const kesari = await managerCtx(h, 'employee', WS_KESARI_SLUG);
    const active = await h.db.extensionToken.count({ where: { workspace: { slug: WS_KESARI_SLUG }, revokedAt: null } });
    const ids: string[] = [];
    for (let i = active; i < 10; i += 1) {
      const res = await create({ workspaceSlug: WS_KESARI_SLUG, name: `Laptop ${i}` });
      expect(res.status).toBe(200);
      ids.push(res.body.id as string);
    }
    const over = await create({ workspaceSlug: WS_KESARI_SLUG, name: 'One too many' });
    expect(over.status).toBe(422);
    expect(over.body.code).toBe('EXTENSION_TOKEN_LIMIT');
    expect((await revoke(ids[0]!, { workspaceSlug: WS_KESARI_SLUG, confirm: 'REVOKE' })).status).toBe(200);
    expect((await create({ workspaceSlug: WS_KESARI_SLUG, name: 'Replacement' })).status).toBe(200);
    expect(kesari.workspaceId).not.toBe(WS_A);
  });

  it('needs extension.manage in the named workspace: 401 anonymous, 403 without it, 404 outside it', async () => {
    expect((await create({ workspaceSlug: WS_A_SLUG, name: 'x' }, null)).status).toBe(401);
    const neha = await sessionFor(h, 'neha');
    expect((await create({ workspaceSlug: 'ironpulse-fitness', name: 'x' }, neha)).status).toBe(403);
    expect((await create({ workspaceSlug: WS_A_SLUG, name: 'x' }, neha)).status).toBe(404);
    const owner = await sessionFor(h, 'owner');
    expect((await create({ workspaceSlug: WS_KESARI_SLUG, name: 'x' }, owner)).status).toBe(404);
  });
});

describe('POST /api/app/extension/tokens/[tokenId]/revoke', () => {
  it('needs the typed confirmation, revokes, audits, and a repeat is idempotent', async () => {
    const token = await issueToken(h);
    expect((await revoke(token.id, { workspaceSlug: WS_A_SLUG })).status).toBe(400);
    expect((await revoke(token.id, { workspaceSlug: WS_A_SLUG, confirm: 'revoke' })).status).toBe(400);
    const done = await revoke(token.id, { workspaceSlug: WS_A_SLUG, confirm: 'REVOKE' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ id: token.id, prefix: token.prefix, alreadyRevoked: false });
    const row = await h.db.extensionToken.findUniqueOrThrow({ where: { id: token.id } });
    expect(row.revokedAt?.toISOString()).toBe(h.clock.now().toISOString());
    expect(await h.db.auditEvent.count({ where: { action: 'extension.token.revoke', targetId: token.id } })).toBe(1);

    const again = await revoke(token.id, { workspaceSlug: WS_A_SLUG, confirm: 'REVOKE' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ alreadyRevoked: true });
    expect(await h.db.auditEvent.count({ where: { action: 'extension.token.revoke', targetId: token.id } })).toBe(1);
  });

  it("another workspace's token id is 404", async () => {
    const kesariToken = await issueToken(h, { workspaceSlug: WS_KESARI_SLUG });
    expect((await revoke(kesariToken.id, { workspaceSlug: WS_A_SLUG, confirm: 'REVOKE' })).status).toBe(404);
    expect((await h.db.extensionToken.findUniqueOrThrow({ where: { id: kesariToken.id } })).revokedAt).toBeNull();
  });
});

describe('POST /api/app/extension/tokens/[tokenId]/allowed-extension', () => {
  it('sets and clears the allowed extension id; refuses a malformed id and a revoked token', async () => {
    const token = await issueToken(h);
    expect((await setAllowed(token.id, { workspaceSlug: WS_A_SLUG, allowedExtensionId: 'not-an-id' })).status).toBe(400);
    const set = await setAllowed(token.id, { workspaceSlug: WS_A_SLUG, allowedExtensionId: EXTENSION_ID });
    expect(set.status).toBe(200);
    expect((await h.db.extensionToken.findUniqueOrThrow({ where: { id: token.id } })).allowedExtensionId).toBe(EXTENSION_ID);
    const cleared = await setAllowed(token.id, { workspaceSlug: WS_A_SLUG, allowedExtensionId: null });
    expect(cleared.status).toBe(200);
    expect((await h.db.extensionToken.findUniqueOrThrow({ where: { id: token.id } })).allowedExtensionId).toBeNull();
    expect(await h.db.auditEvent.count({ where: { action: 'extension.token.allowed_extension', targetId: token.id } })).toBe(2);

    await revoke(token.id, { workspaceSlug: WS_A_SLUG, confirm: 'REVOKE' });
    const refused = await setAllowed(token.id, { workspaceSlug: WS_A_SLUG, allowedExtensionId: EXTENSION_ID });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('TOKEN_REVOKED');
  });
});

describe('hub read model', () => {
  it('webhook URL, deliveries with per-record failures (intake and ingestion), refused uses, never a secret', async () => {
    const token = await issueToken(h, { name: 'Hub laptop' });
    const raw = batchBody('hub-batch-1', [mapsRecord(), mapsRecord({ phone: null, website: null }), { recordId: 'hub-bad', name: ['x'] }]);
    expect((await postBatch(raw, { token: token.token })).res.status).toBe(202);

    let hub = await getExtensionHubDetails(await managerCtx(h), { appOrigin: h.config.appOrigin });
    expect(hub.webhookUrl).toBe(`${h.config.appOrigin}/api/webhooks/gmaps-extension`);
    expect(hub.canManage).toBe(true);
    expect(hub.tokenLimit).toBe(10);
    const queued = hub.deliveries.find((d) => d.batchId === 'hub-batch-1')!;
    expect(queued).toMatchObject({ state: 'QUEUED', simulated: false, tokenPrefix: token.prefix, tokenName: 'Hub laptop', counts: null });
    expect(queued.failures).toEqual([{ recordId: 'hub-bad', status: 'REJECTED', reasonCode: 'INVALID_RECORD' }]);

    await h.drain();
    hub = await getExtensionHubDetails(await managerCtx(h), { appOrigin: h.config.appOrigin });
    const processed = hub.deliveries.find((d) => d.batchId === 'hub-batch-1')!;
    expect(processed).toMatchObject({ state: 'PROCESSED', batchStatus: 'PARTIAL', counts: { received: 3, accepted: 1, rejected: 2 } });
    expect(processed.failures.map((f) => f.reasonCode).sort()).toEqual(['INVALID_RECORD', 'NO_VALID_CONTACT']);

    // A refused use shows its reason and the prefix, never the presented secret.
    const wrong = `${token.prefix}_${'Z'.repeat(43)}`;
    expect((await postBatch(batchBody('hub-refused', [mapsRecord()]), { token: wrong })).res.status).toBe(401);
    hub = await getExtensionHubDetails(await managerCtx(h), { appOrigin: h.config.appOrigin });
    expect(hub.denials[0]).toMatchObject({ prefix: token.prefix, reason: 'SECRET_MISMATCH' });
    const json = JSON.stringify(hub);
    expect(json).not.toContain(token.token.slice(token.prefix.length + 1));
    expect(json).not.toContain('Z'.repeat(43));
  });

  it('without extension.manage the hub says so (permission) and reading still works with leads.read', async () => {
    const neha = await managerCtx(h, 'neha', 'ironpulse-fitness');
    const hub = await getExtensionHubDetails(neha, { appOrigin: h.config.appOrigin });
    expect(hub.canManage).toBe(false);
    expect(hub.manageGate).toMatchObject({ category: 'permission' });
  });
});

describe('Extension hub page', () => {
  const markup = (el: unknown) => renderToStaticMarkup(createElement(CsrfProvider as unknown as FC<{ token: string }>, { token: 'csrf' }, el as ReactElement));
  const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  it('shows the webhook URL, the create form, tokens by prefix with their actions, batches and refusals; never a secret', async () => {
    const token = await issueToken(h, { name: 'Page laptop' });
    await postBatch(batchBody('page-batch-1', [mapsRecord(), { recordId: 'page-bad', name: 7 }]), { token: token.token });
    await postBatch(batchBody('page-refused', [mapsRecord()]), { token: `${token.prefix}_${'Y'.repeat(43)}` });
    pageHeaders.current = new Headers({ cookie: employee.cookie });
    const html = markup(await ExtensionPage({ params: Promise.resolve({ ws: WS_A_SLUG }) }));
    const t = text(html);
    expect(html).toContain(`${h.config.appOrigin}/api/webhooks/gmaps-extension`);
    expect(t).toContain('Create token');
    expect(t).toContain('Page laptop');
    expect(html).toContain(`${token.prefix}_••••`);
    expect(t).toContain('Revoke');
    expect(html).toContain('data-delivery="page-batch-1"');
    expect(t).toContain('Malformed record');
    expect(t).toContain('Wrong secret for this token prefix');
    expect(html).toContain('data-example-payload');
    expect(html).not.toContain(token.token.slice(token.prefix.length + 1));
    expect(html).not.toContain('Y'.repeat(43));
  });

  it('without extension.manage the create control is permission-gated and no revoke control is rendered', async () => {
    const neha = await sessionFor(h, 'neha');
    pageHeaders.current = new Headers({ cookie: neha.cookie });
    const html = markup(await ExtensionPage({ params: Promise.resolve({ ws: 'ironpulse-fitness' }) }));
    expect(html).toContain('aria-disabled="true"');
    expect(text(html)).toContain('Manage extension');
    expect(text(html)).not.toContain('Revoke');
    expect(html).not.toContain('aria-label="Create an ingestion token"');
  });
});
