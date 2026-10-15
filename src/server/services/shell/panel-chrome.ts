/**
 * Read model for the authenticated panel chrome (T08): who is signed in, the resolved workspace,
 * the workspaces this session may switch to, and the pause banners. Everything is derived from
 * the server context (never from the browser): a USER's memberships, an EMPLOYEE's active
 * assignments, nothing for a SUPER_ADMIN (who enters tenants only through the audited
 * adminContext). Workspaces of the other mode never appear (ADR-04).
 *
 * Membership and assignment listings span workspaces, so they read through the context's base
 * client; the filter is always the actor's own user id.
 */
import type { LoadedSession } from '@/server/auth/session';
import { dbMode } from '@/server/auth/session';
import { baseClientOf, type AppCtx } from '@/server/auth/context';

export type ChromeWorkspace = { slug: string; name: string; planLabel: string; mode: 'DEMO' | 'LIVE' };

export type PanelChrome = {
  mode: 'demo' | 'live';
  user: { name: string; email: string; role: 'USER' | 'EMPLOYEE' | 'SUPER_ADMIN'; isDemo: boolean };
  /** The context's resolved workspace (null for admins and for employees without an active one). */
  workspace: ChromeWorkspace | null;
  /** Ordered by name, then slug. */
  switchable: ChromeWorkspace[];
  /** Global kill switch: SystemSetting.outboundPaused or OUTBOUND_PAUSED=1. */
  outboundPaused: boolean;
  /** The resolved workspace's automation pause. */
  automationPaused: boolean;
};

const workspaceSelect = { slug: true, name: true, planLabel: true, mode: true, automationPaused: true } as const;

export async function loadPanelChrome(ctx: AppCtx, session: LoadedSession, opts: { envOutboundPaused: boolean }): Promise<PanelChrome> {
  const prisma = baseClientOf(ctx);
  const mode = dbMode(ctx.mode);
  const { user } = session;

  let switchable: ChromeWorkspace[] = [];
  if (user.globalRole === 'USER') {
    const rows = await prisma.membership.findMany({ where: { userId: user.id, workspace: { mode } }, select: { workspace: { select: workspaceSelect } } });
    switchable = rows.map((r) => r.workspace);
  } else if (user.globalRole === 'EMPLOYEE') {
    const rows = await prisma.employeeAssignment.findMany({
      where: { employeeUserId: user.id, active: true, workspace: { mode } },
      select: { workspace: { select: workspaceSelect } },
    });
    switchable = rows.map((r) => r.workspace);
  }
  switchable = switchable
    .map(({ slug, name, planLabel, mode: m }) => ({ slug, name, planLabel, mode: m }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.slug.localeCompare(b.slug, 'en'));

  const current =
    ctx.workspaceId === null ? null : await prisma.workspace.findUnique({ where: { id: ctx.workspaceId }, select: workspaceSelect });
  const setting = await prisma.systemSetting.findUnique({ where: { id: 1 }, select: { outboundPaused: true } });

  return {
    mode: ctx.mode,
    user: { name: user.name, email: user.email, role: user.globalRole, isDemo: user.isDemo },
    workspace: current ? { slug: current.slug, name: current.name, planLabel: current.planLabel, mode: current.mode } : null,
    switchable,
    outboundPaused: opts.envOutboundPaused || (setting?.outboundPaused ?? false),
    automationPaused: current?.automationPaused ?? false,
  };
}
