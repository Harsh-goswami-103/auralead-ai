/**
 * Harness for the T24 admin tests (inspector actions, queue health, global pause): the T20 inbound
 * harness (seeded DEMO DB, scripted transports, in-process worker with the dispatch, render,
 * reconcile, webhook.process and status.apply jobs, and the process runtime installed so the admin
 * routes run exactly as in the app), plus DB sessions for the seeded super admin with a chosen
 * authentication time, and a request helper that carries the cookie, Origin and CSRF token.
 */
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { seedId } from '../../../prisma/seed/ids';
import { ORIGIN } from '../auth/support';
import { userCtx } from '../quotes/support';
import type { PrismaClient } from '@/generated/prisma/client';
import type { FixedClock } from '@/lib/clock';
import type { AppConfig } from '@/lib/config';

export type SessionHost = { db: PrismaClient; clock: FixedClock; config: AppConfig };

export const ADMIN_ID = seedId('user', 'admin');

export type AdminAuth = { cookie: string; csrf: string; sessionId: string };

/** A DB session of the seeded super admin, created at `createdAt` (default: now), optionally re-authenticated at `reauthAt`. */
export async function adminSession(h: SessionHost, opts: { createdAt?: Date; reauthAt?: Date | null; userKey?: string } = {}): Promise<AdminAuth> {
  const userId = seedId('user', opts.userKey ?? 'admin');
  const user = await h.db.user.findUniqueOrThrow({ where: { id: userId } });
  const { token, session } = await createSession(h.db, {
    userId,
    globalRole: user.globalRole,
    mode: 'DEMO',
    activeWorkspaceId: null,
    ipHash: 'admin-test',
    userAgent: 'vitest',
    now: opts.createdAt ?? h.clock.now(),
    reauthAt: opts.reauthAt ?? null,
  });
  return { cookie: `${sessionCookieName(h.config)}=${token}`, csrf: csrfTokenForSession(h.config, session.id), sessionId: session.id };
}

type Handler = (req: Request, segment: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** Calls a route handler in-process as the given session. */
export async function callRoute(handler: Handler, pathname: string, auth: AdminAuth | null, opts: { method?: string; body?: unknown; params?: Record<string, string> } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  const headers = new Headers({ 'user-agent': 'vitest' });
  if (auth) headers.set('cookie', auth.cookie);
  if (method !== 'GET') {
    headers.set('origin', ORIGIN);
    if (auth) headers.set('x-csrf-token', auth.csrf);
    headers.set('content-type', 'application/json');
  }
  const req = new Request(`${ORIGIN}${pathname}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** The super admin context exactly as a route builds it (no workspace). */
export const adminCtx = (h: Pick<SessionHost, 'db' | 'clock'>) => userCtx(h.db, h.clock, 'admin');
