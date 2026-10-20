/**
 * P7 / T27: logo upload through the real route handlers (withRoute: session, CSRF, roles,
 * capability, body cap) against the seeded DEMO DB and a temp STORAGE_DIR.
 *  - PNG, JPEG and WebP are accepted, re-encoded by sharp to WebP with every metadata block dropped
 *    (EXIF included) and stored content-addressed at branding/<workspaceId>/<sha256>.webp.
 *  - SVG is refused whatever it claims to be; a file whose magic bytes do not match its declared
 *    type or name (a polyglot) is refused; bytes that start with a PNG signature but are not a PNG
 *    are refused; nothing is stored for a refused file.
 *  - Over 1 MB is 413, both when the JSON body passes the cap and when the decoded file is too big.
 *  - The served logo has a fixed image/webp type, nosniff, no-store and an inline disposition;
 *    only the workspace's own members can read it, and only the owner (pricing.override) can
 *    change it. Replacing or removing a logo deletes the old file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { LOGO_MAX_BYTES } from '@/lib/schemas/branding';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import * as logoRoute from '@/app/api/app/branding/logo/route';
import * as removeRoute from '@/app/api/app/branding/logo/remove/route';
import { seedId } from '../../../prisma/seed/ids';
import { seedDemo } from '../../../prisma/seed/seed';
import { createTestDb, type TestDb } from '../../support/db';
import { makeRequest, noParams, testConfig, uninstallRuntime, useRuntime, type TestRuntime } from '../auth/support';

const SEED_NOW = new Date('2026-10-15T04:30:00.000Z');
const NOW = '2026-10-20T06:00:00.000Z';
const WS_A = seedId('workspace', 'smile-avenue-dental');
const WS_KESARI = seedId('workspace', 'kesari-crafts');

let testDb: TestDb;
let db: PrismaClient;
let runtime: TestRuntime;
let storageDir: string;

beforeAll(async () => {
  testDb = await createTestDb({ label: 'logo-upload' });
  db = testDb.client();
  await seedDemo(db, { config: { mode: 'demo' }, now: SEED_NOW });
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auralead-logo-storage-'));
  runtime = useRuntime(db, testConfig('demo', { STORAGE_DIR: storageDir }), new FixedClock(NOW));
});
afterAll(async () => {
  uninstallRuntime();
  await testDb.destroy();
  fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function auth(userKey: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: seedId('user', userKey) } });
  const { token, session } = await createSession(db, { userId: user.id, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'logo', userAgent: 'vitest', now: new Date(NOW) });
  return { cookie: `${sessionCookieName(runtime.config)}=${token}`, csrf: csrfTokenForSession(runtime.config, session.id) };
}

async function upload(userKey: string, body: Record<string, unknown>) {
  const a = await auth(userKey);
  return logoRoute.POST(makeRequest('/api/app/branding/logo', { body, cookie: a.cookie, csrf: a.csrf }), noParams);
}

async function uploadRaw(userKey: string, rawBody: string) {
  const a = await auth(userKey);
  return logoRoute.POST(makeRequest('/api/app/branding/logo', { rawBody, cookie: a.cookie, csrf: a.csrf, headers: { 'content-type': 'application/json' } }), noParams);
}

async function fetchLogo(userKey: string) {
  const a = await auth(userKey);
  return logoRoute.GET(makeRequest('/api/app/branding/logo', { cookie: a.cookie }), noParams);
}

const b64 = (buf: Buffer) => buf.toString('base64');
const codeOf = async (res: Response) => ((await res.json()) as { code?: string }).code;
const brandingFiles = (workspaceId: string) => {
  const dir = path.join(storageDir, 'branding', workspaceId);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.endsWith('.tmp')) : [];
};

async function png(width = 120, height = 60, colour = '#0F766E') {
  return sharp({ create: { width, height, channels: 3, background: colour } }).png().toBuffer();
}

describe('accepted logos', () => {
  it('re-encodes a PNG to WebP, stores it content-addressed and records the path with an audit row', async () => {
    const res = await upload('owner', { contentType: 'image/png', fileName: 'clinic-logo.png', dataBase64: b64(await png()) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { branding: { logo: { sha256: string; url: string } | null } };
    const logo = body.branding.logo!;
    expect(logo.sha256).toMatch(/^[0-9a-f]{64}$/);
    const settings = await db.workspaceSettings.findUniqueOrThrow({ where: { workspaceId: WS_A } });
    expect(settings.logoPath).toBe(`branding/${WS_A}/${logo.sha256}.webp`);
    const stored = fs.readFileSync(path.join(storageDir, settings.logoPath!));
    expect(stored.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(stored.subarray(8, 12).toString('latin1')).toBe('WEBP');
    expect((await sharp(stored).metadata()).format).toBe('webp');
    const audit = await db.auditEvent.findFirstOrThrow({ where: { workspaceId: WS_A, action: 'branding.logo.update' }, orderBy: { createdAt: 'desc' } });
    expect(audit.summary).toMatchObject({ fields: ['logoPath'], sourceType: 'png' });
    expect(JSON.stringify(audit.summary)).not.toContain('clinic-logo');
  });

  it('drops EXIF (and any other metadata) from a JPEG', async () => {
    const jpeg = await sharp({ create: { width: 80, height: 80, channels: 3, background: '#E11D48' } })
      .jpeg()
      .withExif({ IFD0: { Copyright: 'SECRET-EXIF-MARKER', Artist: 'Someone Private' } })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    expect(jpeg.includes(Buffer.from('SECRET-EXIF-MARKER'))).toBe(true);
    const res = await upload('owner', { contentType: 'image/jpeg', fileName: 'logo.jpg', dataBase64: b64(jpeg) });
    expect(res.status).toBe(200);
    const settings = await db.workspaceSettings.findUniqueOrThrow({ where: { workspaceId: WS_A } });
    const stored = fs.readFileSync(path.join(storageDir, settings.logoPath!));
    const meta = await sharp(stored).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(stored.includes(Buffer.from('SECRET-EXIF-MARKER'))).toBe(false);
    expect(stored.includes(Buffer.from('EXIF'))).toBe(false);
    expect(brandingFiles(WS_A)).toHaveLength(1); // the replaced PNG was deleted
  });

  it('accepts a WebP and fits a large image inside 512 px', async () => {
    const webp = await sharp({ create: { width: 2000, height: 500, channels: 4, background: { r: 10, g: 20, b: 200, alpha: 0.5 } } }).webp().toBuffer();
    const res = await upload('owner', { contentType: 'image/webp', dataBase64: b64(webp) });
    expect(res.status).toBe(200);
    const settings = await db.workspaceSettings.findUniqueOrThrow({ where: { workspaceId: WS_A } });
    const meta = await sharp(fs.readFileSync(path.join(storageDir, settings.logoPath!))).metadata();
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(128);
  });

  it('serves the logo with a fixed image/webp type, nosniff and no-store', async () => {
    const res = await fetchLogo('owner');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toMatch(/^inline/);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const settings = await db.workspaceSettings.findUniqueOrThrow({ where: { workspaceId: WS_A } });
    expect(Buffer.from(await res.arrayBuffer()).equals(fs.readFileSync(path.join(storageDir, settings.logoPath!)))).toBe(true);
  });
});

describe('refused logos', () => {
  const before = async () => (await db.workspaceSettings.findUniqueOrThrow({ where: { workspaceId: WS_A } })).logoPath;

  it('refuses SVG, declared as SVG or disguised as PNG', async () => {
    const path0 = await before();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10"/></svg>');
    const declared = await upload('owner', { contentType: 'image/svg+xml', fileName: 'logo.svg', dataBase64: b64(svg) });
    expect(declared.status).toBe(422);
    expect(await codeOf(declared)).toBe('LOGO_TYPE_UNSUPPORTED');
    const disguised = await upload('owner', { contentType: 'image/png', fileName: 'logo.png', dataBase64: b64(Buffer.concat([Buffer.from('<?xml version="1.0"?>'), svg])) });
    expect(disguised.status).toBe(422);
    expect(await codeOf(disguised)).toBe('LOGO_TYPE_MISMATCH');
    expect(await before()).toBe(path0);
  });

  it('refuses a polyglot whose magic bytes do not match the declared type or name', async () => {
    const jpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#000000' } }).jpeg().toBuffer();
    const asPng = await upload('owner', { contentType: 'image/png', dataBase64: b64(jpeg) });
    expect(asPng.status).toBe(422);
    expect(await codeOf(asPng)).toBe('LOGO_TYPE_MISMATCH');
    const wrongName = await upload('owner', { contentType: 'image/jpeg', fileName: 'logo.html', dataBase64: b64(jpeg) });
    expect(wrongName.status).toBe(422);
    expect(await codeOf(wrongName)).toBe('LOGO_TYPE_MISMATCH');
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from('<script>alert(1)</script>')]);
    const gifRes = await upload('owner', { contentType: 'image/png', dataBase64: b64(gif) });
    expect(gifRes.status).toBe(422);
    expect(await codeOf(gifRes)).toBe('LOGO_TYPE_MISMATCH');
    const fakePng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('<html><script>alert(1)</script></html>')]);
    const fake = await upload('owner', { contentType: 'image/png', fileName: 'logo.png', dataBase64: b64(fakePng) });
    expect(fake.status).toBe(422);
    expect(await codeOf(fake)).toBe('LOGO_UNREADABLE');
  });

  it('refuses bad base64 with 400', async () => {
    const res = await upload('owner', { contentType: 'image/png', dataBase64: 'not*base64!' });
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe('LOGO_ENCODING_INVALID');
  });

  it('answers 413 above 1 MB, whether the body passes the cap or not', async () => {
    const path0 = await before();
    const justOver = Buffer.alloc(LOGO_MAX_BYTES + 1, 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(justOver);
    const decoded = await upload('owner', { contentType: 'image/png', dataBase64: b64(justOver) });
    expect(decoded.status).toBe(413);
    expect(await codeOf(decoded)).toBe('LOGO_TOO_LARGE');
    const huge = await uploadRaw('owner', JSON.stringify({ contentType: 'image/png', dataBase64: b64(Buffer.alloc(3 * LOGO_MAX_BYTES, 1)) }));
    expect(huge.status).toBe(413);
    expect(await before()).toBe(path0);
    expect(brandingFiles(WS_A)).toHaveLength(1);
  });
});

describe('who may upload and read', () => {
  it('a member without pricing.override gets 403, an employee 404, no session 401', async () => {
    const pngBody = { contentType: 'image/png', dataBase64: b64(await png()) };
    expect((await upload('pooja', pngBody)).status).toBe(403);
    expect((await upload('employee', pngBody)).status).toBe(404);
    expect((await logoRoute.POST(makeRequest('/api/app/branding/logo', { body: pngBody }), noParams)).status).toBe(401);
    expect(brandingFiles(WS_KESARI)).toHaveLength(0);
  });

  it("each workspace reads only its own logo: another owner's request is 404 LOGO_NOT_SET", async () => {
    const res = await fetchLogo('vikram'); // kesari-crafts has no logo
    expect(res.status).toBe(404);
    expect(await codeOf(res)).toBe('LOGO_NOT_SET');
    expect((await fetchLogo('pooja')).status).toBe(404);
    const anon = await logoRoute.GET(makeRequest('/api/app/branding/logo'), noParams);
    expect(anon.status).toBe(401);
  });
});

describe('removing the logo', () => {
  it('clears the path, deletes the file, audits once and is idempotent', async () => {
    const a = await auth('owner');
    const res = await removeRoute.POST(makeRequest('/api/app/branding/logo/remove', { body: {}, cookie: a.cookie, csrf: a.csrf }), noParams);
    expect(res.status).toBe(200);
    expect((await db.workspaceSettings.findUniqueOrThrow({ where: { workspaceId: WS_A } })).logoPath).toBeNull();
    expect(brandingFiles(WS_A)).toHaveLength(0);
    expect((await fetchLogo('owner')).status).toBe(404);
    const again = await removeRoute.POST(makeRequest('/api/app/branding/logo/remove', { body: {}, cookie: a.cookie, csrf: a.csrf }), noParams);
    expect(again.status).toBe(200);
    expect(await db.auditEvent.count({ where: { workspaceId: WS_A, action: 'branding.logo.remove' } })).toBe(1);
  });
});
