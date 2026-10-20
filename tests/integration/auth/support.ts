/**
 * Shared harness for the T06 auth tests: a parsed config for either mode, a runtime installed
 * on a real test DB (so route handlers run exactly as in the app), seeded identities with real
 * argon2id hashes, and a small Request builder that carries cookies, Origin and the CSRF token.
 */
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { parseConfig, type AppConfig } from '@/lib/config';
import { createLogger } from '@/lib/logger';
import { hashPassword } from '@/server/auth/password';
import { installRuntime, uninstallRuntime, type Runtime } from '@/server/boot';
import { createRateLimiters } from '@/server/security/rate-limit';

export const ORIGIN = 'http://localhost:3000';
export const NOW = '2026-10-15T10:00:00.000Z';
export const PASSWORD = 'correct horse battery staple';

const secret = (seed: string) => `${seed}-${'s'.repeat(40)}`;

export function testEnv(mode: 'demo' | 'live', extra: Record<string, string> = {}): Record<string, string> {
  return {
    APP_MODE: mode,
    // Pinned too: a developer's generated .env carries NEXT_PUBLIC_APP_MODE=demo, which a child
    // process would otherwise inherit (real environment variables win over .env).
    NEXT_PUBLIC_APP_MODE: mode,
    APP_ORIGIN: ORIGIN,
    AURALEAD_DATA_DIR: path.join(os.tmpdir(), 'auralead-auth-test-data'),
    SESSION_SECRET: secret('session'),
    SHARE_NONCE_KEY: secret('share'),
    SUPPRESSION_PEPPER: secret('pepper'),
    CREDENTIALS_KEYRING: JSON.stringify({ k1: randomBytes(32).toString('base64') }),
    CREDENTIALS_ACTIVE_KID: 'k1',
    LOG_LEVEL: 'silent',
    ...extra,
  };
}

export function testConfig(mode: 'demo' | 'live', extra: Record<string, string> = {}): AppConfig {
  return parseConfig(testEnv(mode, extra));
}

export type TestRuntime = Runtime & { clock: FixedClock };

/** Installs the process runtime used by withRoute() on the given client and config. */
export function useRuntime(prisma: PrismaClient, config: AppConfig, clock = new FixedClock(NOW)): TestRuntime {
  const runtime: TestRuntime = {
    config,
    prisma,
    limiters: createRateLimiters(clock),
    logger: createLogger({ level: 'silent' }),
    baseClock: clock,
    warnings: [],
    clock,
  };
  installRuntime(runtime);
  return runtime;
}

export { uninstallRuntime };

export type Identity = {
  workspaceAId: string;
  workspaceBId: string;
  ownerId: string;
  memberId: string;
  employeeId: string;
  unassignedEmployeeId: string;
  adminId: string;
  demoOwnerId: string;
};

/** Two workspaces (alpha, beta) and one user per role, all with PASSWORD. */
export async function seedIdentities(db: PrismaClient, mode: 'DEMO' | 'LIVE' = 'LIVE'): Promise<Identity> {
  const passwordHash = await hashPassword(PASSWORD);
  const wsA = await db.workspace.create({ data: { slug: 'alpha', name: 'Alpha Dental', mode, planLabel: 'Starter' } });
  const wsB = await db.workspace.create({ data: { slug: 'beta', name: 'Beta Interiors', mode, planLabel: 'Starter' } });
  for (const ws of [wsA, wsB]) {
    await db.workspaceSettings.create({ data: { workspaceId: ws.id, maxDiscountBps: 1500, brandColor: '#0F766E', termsText: 'Terms' } });
  }
  const mk = (email: string, globalRole: 'USER' | 'EMPLOYEE' | 'SUPER_ADMIN', isDemo = false) =>
    db.user.create({ data: { email, name: email.split('@')[0]!, globalRole, passwordHash, isDemo } });
  const owner = await mk('owner@alpha.test', 'USER');
  const member = await mk('member@alpha.test', 'USER');
  const employee = await mk('employee@example.test', 'EMPLOYEE');
  const unassigned = await mk('unassigned@example.test', 'EMPLOYEE');
  const admin = await mk('admin@example.test', 'SUPER_ADMIN');
  const demoOwner = await mk('demo-owner@alpha.test', 'USER', true);
  await db.membership.create({ data: { userId: owner.id, workspaceId: wsA.id, role: 'OWNER' } });
  await db.membership.create({ data: { userId: member.id, workspaceId: wsA.id, role: 'MEMBER' } });
  await db.membership.create({ data: { userId: demoOwner.id, workspaceId: wsA.id, role: 'OWNER' } });
  await db.employeeAssignment.create({
    data: { employeeUserId: employee.id, workspaceId: wsA.id, capabilities: ['leads.read', 'drafts.generate'], maxDiscountBps: 500, createdBy: admin.id },
  });
  return {
    workspaceAId: wsA.id,
    workspaceBId: wsB.id,
    ownerId: owner.id,
    memberId: member.id,
    employeeId: employee.id,
    unassignedEmployeeId: unassigned.id,
    adminId: admin.id,
    demoOwnerId: demoOwner.id,
  };
}

export type ReqOptions = {
  method?: string;
  body?: unknown;
  rawBody?: string;
  cookie?: string | null;
  origin?: string | null;
  csrf?: string | null;
  headers?: Record<string, string>;
};

export function makeRequest(pathname: string, opts: ReqOptions = {}): Request {
  const method = opts.method ?? (opts.body !== undefined || opts.rawBody !== undefined ? 'POST' : 'GET');
  const headers = new Headers(opts.headers);
  if (opts.cookie) headers.set('cookie', opts.cookie);
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null && method !== 'GET') headers.set('origin', origin);
  if (opts.csrf) headers.set('x-csrf-token', opts.csrf);
  let body: string | undefined;
  if (opts.rawBody !== undefined) body = opts.rawBody;
  else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers.set('content-type', 'application/json');
  }
  return new Request(`${ORIGIN}${pathname}`, { method, headers, body });
}

/** The `name=value` pair from a Set-Cookie header, for sending back as a Cookie header. */
export function cookieFrom(res: Response): string | null {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  return raw.split(';')[0]!.trim();
}

export const noParams = { params: Promise.resolve({}) };
