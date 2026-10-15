/**
 * DEMO role switcher identities (T2, ADR-04, PRD "Role switcher"). The switcher may only name one
 * of these fixed keys; the server maps it to a seeded `isDemo` user by email. The seed (T09)
 * creates exactly these users and must call `assertDemoSeedTarget` first.
 */
import type { GlobalRole, Prisma } from '@/generated/prisma/client';

export const DEMO_PERSONAS = {
  user: { email: 'owner@demo.auralead.test', label: 'Workspace owner', globalRole: 'USER', home: '/dashboard/user' },
  employee: { email: 'employee@demo.auralead.test', label: 'Employee', globalRole: 'EMPLOYEE', home: '/dashboard/employee' },
  admin: { email: 'admin@demo.auralead.test', label: 'Super admin', globalRole: 'SUPER_ADMIN', home: '/dashboard/admin' },
} as const satisfies Record<string, { email: string; label: string; globalRole: GlobalRole; home: string }>;

export type DemoPersona = keyof typeof DEMO_PERSONAS;
export const DEMO_PERSONA_KEYS = Object.keys(DEMO_PERSONAS) as [DemoPersona, ...DemoPersona[]];

/** The landing panel for a role (used after login and persona switches). */
export function homeForRole(role: GlobalRole): string {
  if (role === 'SUPER_ADMIN') return '/dashboard/admin';
  if (role === 'EMPLOYEE') return '/dashboard/employee';
  return '/dashboard/user';
}

export class SeedTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedTargetError';
  }
}

/**
 * Refuses to seed unless the process is in DEMO and the target DB holds no LIVE workspace and no
 * non-demo user (so a mis-pointed DATABASE_URL can never overwrite live data).
 */
export async function assertDemoSeedTarget(
  config: { mode: 'demo' | 'live' },
  db: Pick<Prisma.TransactionClient, 'workspace' | 'user'>,
): Promise<void> {
  if (config.mode !== 'demo') throw new SeedTargetError('Refusing to seed: the process is in LIVE mode. Demo seed data never goes into a LIVE database.');
  const liveWorkspaces = await db.workspace.count({ where: { mode: 'LIVE' } });
  if (liveWorkspaces > 0) throw new SeedTargetError(`Refusing to seed: the target database holds ${liveWorkspaces} LIVE workspace(s).`);
  const realUsers = await db.user.count({ where: { isDemo: false } });
  if (realUsers > 0) throw new SeedTargetError(`Refusing to seed: the target database holds ${realUsers} non-demo user(s).`);
}
