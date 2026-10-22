/**
 * LIVE harness for the T34 Sheets tests: a migrated DB with no DEMO seed, two LIVE workspaces (A and
 * B) with an OWNER each and a MEMBER in A (no `sheets.manage`), the runtime installed with one LIVE
 * config (the route's key ring is the worker's), an in-process worker running the production
 * `ingest.process`, `webhook.purge` and `sheets.sync` handlers, and a scripted Google stand-in
 * (`FakeGoogle`) that answers the token endpoint (verifying the JWT the adapter signs with the
 * stored service account key) and the Sheets API from documented-shape fixtures. Zero outbound
 * connections: an unscripted request fails the test.
 */
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import type { AppConfig } from '@/lib/config';
import { createLogger } from '@/lib/logger';
import type { OutboundRequest, OutboundResponse } from '@/server/adapters/http/outbound';
import { buildUserContext, type AppCtx } from '@/server/auth/context';
import { createSession, loadSession } from '@/server/auth/session';
import { createIngestProcessJob } from '@/server/jobs/handlers/ingest-process';
import { createSheetsSyncJob } from '@/server/jobs/handlers/sheets-sync';
import { createWebhookPurgeJob } from '@/server/jobs/handlers/webhook-purge';
import { buildJobRegistry } from '@/server/jobs/registry';
import { credentialAad, encryptSecret, type KeyRing } from '@/server/security/secrets';
import type { SheetsDeps } from '@/server/services/sheets/access';
import { confirmSheetMapping } from '@/server/services/sheets/mapping';
import { issueAppsScriptSecret } from '@/server/services/sheets/secret';
import { signSheetsPush, SHEETS_SIGNATURE_HEADERS } from '@/server/services/sheets/signature';
import type { SheetsMappingInput } from '@/lib/schemas/sheets';
import { POST as pushRoute } from '@/app/api/webhooks/google-sheets/route';
import { createWorker, type Worker } from '../../../worker/worker';
import { createTestDb, type TestDb } from '../../support/db';
import { testConfig, uninstallRuntime, useRuntime as installTestRuntime } from '../auth/support';

export const NOW = '2026-10-20T06:00:00.000Z';
export const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
export const SA_EMAIL = 'auralead-reader@demo-project.iam.gserviceaccount.com';
export const HEADER = ['Timestamp', 'Full name', 'Phone number', 'Email address', 'Interested in', 'WhatsApp updates'];
export const NOTICE = 'Yes, send me appointment reminders and offers on WhatsApp. Reply STOP to opt out.';

export const MAPPING: SheetsMappingInput = {
  fieldMap: { name: 'Full name', phone: 'Phone number', email: 'Email address', category: 'Interested in' },
  submittedAtColumn: 'Timestamp',
  consent: { column: 'WhatsApp updates', truthyValues: ['Yes'], channel: 'WHATSAPP', purpose: 'MARKETING', noticeText: NOTICE },
};

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/sheets/documented-shape');
export function sheetsFixture(name: string): { status: number; body: unknown } {
  const sources = JSON.parse(readFileSync(path.join(FIXTURES, 'SOURCES.json'), 'utf8')) as { files: Record<string, { httpStatus: number }> };
  const status = sources.files[name]?.httpStatus;
  if (status === undefined) throw new Error(`no fixture ${name}`);
  return { status, body: JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as unknown };
}

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'demo-project',
  private_key_id: 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0',
  private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  client_email: SA_EMAIL,
  client_id: '109876543210987654321',
  token_uri: 'https://oauth2.googleapis.com/token',
});

export type GoogleRequest = { method: string; url: URL; headers: Record<string, string>; body: string | null };
type Answer = { status: number; body: unknown; headers?: Record<string, string> } | { throw: Error & { code?: string } };

/** The scripted Google: token endpoint plus Sheets API routes; the sheet's cells are kept here. */
export class FakeGoogle {
  readonly requests: GoogleRequest[] = [];
  readonly unexpected: GoogleRequest[] = [];
  /** Row 1 and the data rows, as `values.get` returns them (unformatted). */
  header: string[] = [...HEADER];
  rows: unknown[][] = [];
  timeZone = 'Asia/Kolkata';
  tabs = ['Form Responses 1', 'Summary'];
  /** One-shot overrides for the next matching request (`token`, `meta`, `values`). */
  readonly overrides: Partial<Record<'token' | 'meta' | 'values', Answer[]>> = {};
  tokenClaims: Array<Record<string, unknown>> = [];

  reset(): void {
    this.requests.length = 0;
    this.unexpected.length = 0;
    this.header = [...HEADER];
    this.rows = [];
    for (const k of Object.keys(this.overrides)) delete this.overrides[k as keyof FakeGoogle['overrides']];
    this.tokenClaims = [];
  }

  fail(kind: 'token' | 'meta' | 'values', ...answers: Answer[]): this {
    (this.overrides[kind] ??= []).push(...answers);
    return this;
  }

  private respond(a: Answer): OutboundResponse {
    if ('throw' in a) throw a.throw;
    return { statusCode: a.status, headers: { 'content-type': 'application/json', ...(a.headers ?? {}) }, body: JSON.stringify(a.body) };
  }

  readonly http = async (url: string, init: OutboundRequest): Promise<OutboundResponse> => {
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body === undefined ? null : Buffer.isBuffer(init.body) ? init.body.toString('utf8') : init.body;
    const req: GoogleRequest = { method: init.method, url: u, headers, body };
    this.requests.push(req);
    if (init.method === 'POST' && u.origin === 'https://oauth2.googleapis.com' && u.pathname === '/token') {
      const next = this.overrides.token?.shift();
      if (next) return this.respond(next);
      const form = new URLSearchParams(body ?? '');
      const jwt = form.get('assertion') ?? '';
      const [h, p, s] = jwt.split('.');
      const verify = createVerify('RSA-SHA256');
      verify.update(`${h}.${p}`);
      if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || !verify.verify(keys.publicKey, Buffer.from(s ?? '', 'base64url'))) return this.respond(sheetsFixture('error.token-invalid-grant.json'));
      this.tokenClaims.push(JSON.parse(Buffer.from(p ?? '', 'base64url').toString('utf8')) as Record<string, unknown>);
      return this.respond(sheetsFixture('response.token.json'));
    }
    if (u.origin === 'https://sheets.googleapis.com' && init.method === 'GET') {
      if (headers.authorization !== 'Bearer ya29.documented-shape-token-not-real') return this.respond({ status: 401, body: { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } } });
      const metaPath = `/v4/spreadsheets/${SHEET_ID}`;
      if (u.pathname === metaPath) {
        const next = this.overrides.meta?.shift();
        if (next) return this.respond(next);
        return this.respond({ status: 200, body: { properties: { timeZone: this.timeZone }, sheets: this.tabs.map((title) => ({ properties: { title } })) } });
      }
      if (u.pathname.startsWith(`${metaPath}/values/`)) {
        const next = this.overrides.values?.shift();
        if (next) return this.respond(next);
        const range = decodeURIComponent(u.pathname.slice(`${metaPath}/values/`.length));
        const m = /^'((?:[^']|'')*)'!(\d+):(\d+)$/.exec(range);
        if (!m || !this.tabs.includes(m[1]!.replace(/''/g, "'"))) return this.respond(sheetsFixture('error.400-bad-range.json'));
        const from = Number(m[2]);
        const to = Number(m[3]);
        const all: unknown[][] = [this.header, ...this.rows];
        let values = all.slice(from - 1, to);
        while (values.length > 0 && (values.at(-1) ?? []).length === 0) values = values.slice(0, -1);
        return this.respond({ status: 200, body: { range: `'${m[1]}'!A${from}:Z${to}`, majorDimension: 'ROWS', ...(values.length > 0 ? { values } : {}) } });
      }
    }
    this.unexpected.push(req);
    throw new Error(`unscripted Google request ${init.method} ${u.origin}${u.pathname}`);
  };
}

export type SheetsHarness = {
  testDb: TestDb;
  db: PrismaClient;
  clock: FixedClock;
  config: AppConfig;
  ring: KeyRing;
  pepper: string;
  google: FakeGoogle;
  deps: SheetsDeps;
  wsA: { id: string; slug: string; ownerId: string; memberId: string };
  wsB: { id: string; slug: string; ownerId: string };
  worker: Worker;
  drain: () => Promise<number>;
  ctx: (userId: string, workspaceId: string) => Promise<AppCtx>;
  destroy: () => Promise<void>;
};

let seq = 0;

export async function createSheetsHarness(label: string): Promise<SheetsHarness> {
  const testDb = await createTestDb({ label });
  const db = testDb.client();
  const clock = new FixedClock(NOW);
  const config = testConfig('live');
  installTestRuntime(db, config, clock);
  const ring = config.secrets.credentials!;
  const pepper = config.secrets.suppressionPepper!;
  const google = new FakeGoogle();
  const deps: SheetsDeps = { keyRing: ring, sheets: { http: google.http } };

  const mk = async (slug: string) => {
    const ws = await db.workspace.create({ data: { slug, name: slug, mode: 'LIVE', planLabel: 'Growth', timezone: 'Asia/Kolkata' } });
    await db.workspaceSettings.create({ data: { workspaceId: ws.id, maxDiscountBps: 1000, brandColor: '#0F766E', termsText: 'Terms' } });
    const owner = await db.user.create({ data: { email: `owner@${slug}.test`, name: `Owner ${slug}`, globalRole: 'USER', isDemo: false } });
    await db.membership.create({ data: { userId: owner.id, workspaceId: ws.id, role: 'OWNER' } });
    return { ws, owner };
  };
  const a = await mk('sheets-a');
  const b = await mk('sheets-b');
  const member = await db.user.create({ data: { email: 'member@sheets-a.test', name: 'Member A', globalRole: 'USER', isDemo: false } });
  await db.membership.create({ data: { userId: member.id, workspaceId: a.ws.id, role: 'MEMBER' } });

  const live = { keyRing: ring, contactKeyPepper: pepper, mode: 'live' as const };
  const registry = buildJobRegistry([createIngestProcessJob({ deps: () => live }), createWebhookPurgeJob(), createSheetsSyncJob({ deps: () => ({ ...live, sheets: { http: google.http } }) })]);
  const worker = createWorker(
    { db, clock, registry, logger: createLogger({ level: 'silent' }), mode: 'live', version: 'test', random: () => 0 },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
  const drain = async () => {
    let ran = 0;
    while ((await worker.tick()) === 'ran') ran += 1;
    return ran;
  };
  const ctx = async (userId: string, workspaceId: string): Promise<AppCtx> => {
    seq += 1;
    const { token } = await createSession(db, { userId, globalRole: 'USER', mode: 'LIVE', activeWorkspaceId: workspaceId, ipHash: 'sheets', userAgent: 'vitest', now: clock.now() });
    const loaded = (await loadSession(db, token, { now: clock.now(), mode: 'LIVE' }))!;
    return buildUserContext(loaded, { prisma: db, mode: 'live', clock }, { correlationId: `req_t34_${String(seq).padStart(4, '0')}` });
  };
  return {
    testDb,
    db,
    clock,
    config,
    ring,
    pepper,
    google,
    deps,
    wsA: { id: a.ws.id, slug: a.ws.slug, ownerId: a.owner.id, memberId: member.id },
    wsB: { id: b.ws.id, slug: b.ws.slug, ownerId: b.owner.id },
    worker,
    drain,
    ctx,
    destroy: async () => {
      uninstallRuntime();
      await testDb.destroy();
    },
  };
}

/** A GOOGLE_SHEETS integration stored exactly as the credential writer stores it. */
export async function storeSheets(h: SheetsHarness, workspaceId: string, opts: { status?: 'CONNECTED' | 'CONFIGURED_UNVERIFIED'; sheetName?: string } = {}) {
  const existing = await h.db.integration.findFirst({ where: { workspaceId, kind: 'GOOGLE_SHEETS' } });
  const row = existing ?? (await h.db.integration.create({ data: { workspaceId, kind: 'GOOGLE_SHEETS', status: opts.status ?? 'CONNECTED', config: { sheetId: SHEET_ID, ...(opts.sheetName ? { sheetName: opts.sheetName } : {}) } } }));
  const envelope = encryptSecret(h.ring, SERVICE_ACCOUNT_JSON, credentialAad({ workspaceId, integrationId: row.id, field: 'serviceAccountJson' }));
  return h.db.integration.update({ where: { id: row.id }, data: { status: opts.status ?? 'CONNECTED', secrets: { serviceAccountJson: envelope }, secretLast4: { serviceAccountJson: { last4: null, updatedAt: NOW } } } });
}

/** Integration + confirmed mapping + issued secret for one workspace (through the services). */
export async function setUpWorkspace(h: SheetsHarness, ws: { id: string; ownerId: string }) {
  await storeSheets(h, ws.id);
  const owner = await h.ctx(ws.ownerId, ws.id);
  const { analyzeHeader } = await import('@/server/services/sheets/header');
  const mapping = await confirmSheetMapping(owner, { expectedVersion: 0, headerFingerprint: analyzeHeader(HEADER).fingerprint, mapping: MAPPING }, h.deps);
  const issued = await issueAppsScriptSecret(owner, {}, { keyRing: h.ring });
  const integration = await h.db.integration.findFirstOrThrow({ where: { workspaceId: ws.id, kind: 'GOOGLE_SHEETS' } });
  return { integrationId: integration.id, mappingVersion: mapping.version, keyId: issued.keyId, secret: issued.secret };
}

export type PushRow = { rowKey?: string; submittedAt?: string; values: Record<string, string | number | boolean | null> };

let pushSeq = 0;
export function pushBody(rows: PushRow[], opts: { eventId?: string; mappingVersion?: number; header?: string[] | null; sheetId?: string } = {}) {
  pushSeq += 1;
  return {
    version: 1,
    eventId: opts.eventId ?? `evt-${String(pushSeq).padStart(4, '0')}`,
    sheetId: opts.sheetId ?? SHEET_ID,
    mappingVersion: opts.mappingVersion ?? 1,
    ...(opts.header === null ? {} : { header: opts.header ?? HEADER }),
    rows,
  };
}

let personSeq = 0;
export function formRow(opts: { name?: string; phone?: string; email?: string; whatsapp?: 'Yes' | 'No'; rowKey?: string | null; submittedAt?: string } = {}): PushRow {
  personSeq += 1;
  return {
    ...(opts.rowKey === null ? {} : { rowKey: opts.rowKey ?? `row-${String(personSeq).padStart(4, '0')}` }),
    submittedAt: opts.submittedAt ?? '2026-10-20T05:00:00.000Z',
    values: {
      Timestamp: opts.submittedAt ?? '2026-10-20T05:00:00.000Z',
      'Full name': opts.name ?? `Form Person ${personSeq}`,
      'Phone number': opts.phone ?? `98110${String(personSeq).padStart(5, '0')}`,
      'Email address': opts.email ?? `person${personSeq}@example.test`,
      'Interested in': 'Consultation',
      'WhatsApp updates': opts.whatsapp ?? 'Yes',
    },
  };
}

/** Posts raw bytes to the real route with signature headers (each overridable). */
export async function postRaw(raw: string | Buffer, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = new Request('http://localhost:3000/api/webhooks/google-sheets', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof raw === 'string' ? raw : new Uint8Array(raw) });
  const res = await pushRoute(req, { params: Promise.resolve({}) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export async function postPush(h: SheetsHarness, auth: { keyId: string; secret: string }, body: unknown, opts: { timestamp?: number; eventIdHeader?: string; signature?: string } = {}) {
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  const ts = String(opts.timestamp ?? Math.floor(h.clock.now().getTime() / 1000));
  const eventId = opts.eventIdHeader ?? String((body as { eventId?: unknown }).eventId ?? 'none');
  return postRaw(raw, {
    [SHEETS_SIGNATURE_HEADERS.keyId]: auth.keyId,
    [SHEETS_SIGNATURE_HEADERS.timestamp]: ts,
    [SHEETS_SIGNATURE_HEADERS.eventId]: eventId,
    [SHEETS_SIGNATURE_HEADERS.signature]: opts.signature ?? signSheetsPush(auth.secret, ts, eventId, raw),
  });
}
