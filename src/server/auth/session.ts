/**
 * Database sessions (ADR-11, plan §9 Auth, T2 demo isolation).
 *
 * - The cookie carries 32 random bytes (base64url); only sha256(token) is stored (`tokenHash`).
 * - Cookie `__Host-aura_session` (HttpOnly, Secure, SameSite=Lax, Path=/). With
 *   AUTH_COOKIE_INSECURE_DEV=1 the name drops the `__Host-` prefix and the Secure flag, for
 *   non-localhost dev hosts only.
 * - Idle 7 days (sliding, refreshed at most every 5 minutes so reads do not contend for the single
 *   SQLite writer), absolute 30 days, super admin 12 hours absolute.
 * - A session is valid only in the mode that created it, never for a disabled user, and in LIVE
 *   never for an `isDemo` user.
 * - Rotation (login, re-auth, persona switch; see issue.ts) revokes the presented session and
 *   issues a new token;
 *   role, status or membership changes revoke every session of the user.
 *
 * Framework-free (no next/*): route handlers pass headers in, and get Set-Cookie strings out.
 */
import type { AppMode as DbAppMode, GlobalRole, Prisma, Session, UserStatus } from '@/generated/prisma/client';
import { hmacSha256 } from '@/server/security/hmac';
import { generateToken, hashToken, isWellFormedToken } from '@/server/security/tokens';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const SESSION_POLICY = {
  idleMs: 7 * DAY,
  absoluteMs: 30 * DAY,
  superAdminAbsoluteMs: 12 * HOUR,
  reauthWindowMs: 15 * 60_000,
  touchIntervalMs: 5 * 60_000,
} as const;

/** A client or an interactive-transaction client. */
export type SessionDb = Pick<Prisma.TransactionClient, 'session'>;
type SessionUserDb = Pick<Prisma.TransactionClient, 'session' | 'user'>;

/** The subset of AppConfig the cookie helpers need. */
export type CookieConfig = { authCookieInsecureDev: boolean };

export function dbMode(mode: 'demo' | 'live'): DbAppMode {
  return mode === 'live' ? 'LIVE' : 'DEMO';
}

export function sessionCookieName(config: CookieConfig): string {
  return config.authCookieInsecureDev ? 'aura_session' : '__Host-aura_session';
}

function cookieAttributes(config: CookieConfig): string {
  return config.authCookieInsecureDev ? 'Path=/; HttpOnly; SameSite=Lax' : 'Path=/; HttpOnly; Secure; SameSite=Lax';
}

export function buildSessionCookie(config: CookieConfig, token: string, expiresAt: Date, now: Date): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  return `${sessionCookieName(config)}=${token}; ${cookieAttributes(config)}; Max-Age=${maxAge}`;
}

export function buildClearedSessionCookie(config: CookieConfig): string {
  return `${sessionCookieName(config)}=; ${cookieAttributes(config)}; Max-Age=0`;
}

/** The session token from a Cookie header, or null when absent or malformed. */
export function readSessionToken(headers: Headers, config: CookieConfig): string | null {
  const raw = headers.get('cookie');
  if (!raw) return null;
  const name = sessionCookieName(config);
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return isWellFormedToken(value) ? value : null;
  }
  return null;
}

/** Keyed hash of the client address (never stored in clear). */
export function hashClientIp(sessionSecret: string, ip: string): string {
  return hmacSha256(sessionSecret, `ip:${ip}`).toString('hex').slice(0, 32);
}

export type CreateSessionInput = {
  userId: string;
  globalRole: GlobalRole;
  mode: DbAppMode;
  activeWorkspaceId: string | null;
  ipHash: string;
  userAgent: string;
  now: Date;
  /** Kept on rotation after a password re-entry. */
  reauthAt?: Date | null;
};

export async function createSession(db: SessionDb, input: CreateSessionInput): Promise<{ token: string; session: Session }> {
  const { token, tokenHash } = generateToken();
  const absoluteMs = input.globalRole === 'SUPER_ADMIN' ? SESSION_POLICY.superAdminAbsoluteMs : SESSION_POLICY.absoluteMs;
  const absoluteExpiresAt = new Date(input.now.getTime() + absoluteMs);
  const idleExpiresAt = new Date(Math.min(input.now.getTime() + SESSION_POLICY.idleMs, absoluteExpiresAt.getTime()));
  const session = await db.session.create({
    data: {
      userId: input.userId,
      tokenHash,
      activeWorkspaceId: input.activeWorkspaceId,
      mode: input.mode,
      createdAt: input.now,
      lastSeenAt: input.now,
      idleExpiresAt,
      absoluteExpiresAt,
      ipHash: input.ipHash,
      userAgent: input.userAgent.slice(0, 512),
      reauthAt: input.reauthAt ?? null,
    },
  });
  return { token, session };
}

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  globalRole: GlobalRole;
  status: UserStatus;
  isDemo: boolean;
};

export type LoadedSession = { session: Session; user: SessionUser };

const USER_SELECT = { id: true, email: true, name: true, globalRole: true, status: true, isDemo: true } as const;

/**
 * Resolves a presented token to a live session. Returns null (never throws) for an unknown,
 * revoked, expired, wrong-mode or demo-in-LIVE session, or a user who is not ACTIVE.
 */
export async function loadSession(db: SessionUserDb, token: string, opts: { now: Date; mode: DbAppMode }): Promise<LoadedSession | null> {
  if (!isWellFormedToken(token)) return null;
  const row = await db.session.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: { select: USER_SELECT } } });
  if (!row) return null;
  const now = opts.now.getTime();
  if (row.revokedAt !== null) return null;
  if (now >= row.idleExpiresAt.getTime() || now >= row.absoluteExpiresAt.getTime()) return null;
  if (row.mode !== opts.mode) return null;
  if (row.user.status !== 'ACTIVE') return null;
  if (opts.mode === 'LIVE' && row.user.isDemo) return null;

  const { user, ...session } = row;
  if (now - session.lastSeenAt.getTime() >= SESSION_POLICY.touchIntervalMs) {
    const idleExpiresAt = new Date(Math.min(now + SESSION_POLICY.idleMs, session.absoluteExpiresAt.getTime()));
    const touched = await db.session.updateMany({ where: { id: session.id, revokedAt: null }, data: { lastSeenAt: opts.now, idleExpiresAt } });
    if (touched.count !== 1) return null;
    session.lastSeenAt = opts.now;
    session.idleExpiresAt = idleExpiresAt;
  }
  return { session, user };
}

export async function revokeSession(db: SessionDb, sessionId: string, now: Date): Promise<void> {
  await db.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: now } });
}

/** Revokes every active session of the user (role, status, membership or assignment change). */
export async function revokeUserSessions(db: SessionDb, userId: string, now: Date): Promise<number> {
  const res = await db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
  return res.count;
}

/** Password re-entry within the last 15 minutes (global pause, elevated drilldown). */
export function hasRecentReauth(session: Pick<Session, 'reauthAt'>, now: Date): boolean {
  if (session.reauthAt === null) return false;
  const age = now.getTime() - session.reauthAt.getTime();
  return age >= 0 && age < SESSION_POLICY.reauthWindowMs;
}

/** Revokes the session a presented token belongs to (rotation at login and persona switch). */
export async function revokeSessionByToken(db: SessionDb, token: string | null, now: Date): Promise<void> {
  if (token === null || !isWellFormedToken(token)) return;
  await db.session.updateMany({ where: { tokenHash: hashToken(token), revokedAt: null }, data: { revokedAt: now } });
}
