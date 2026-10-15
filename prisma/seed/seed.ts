/**
 * The deterministic DEMO seed (T09, R43). Every row has a deterministic id (ids.ts) and every
 * timestamp is derived from one anchor time (`SEED_NOW`, or the current time floored to the
 * hour), so two seeds with the same anchor are byte-identical and `demo:refresh` can re-base
 * times without changing ids (P20).
 *
 * Safety: `assertDemoSeedTarget` runs first on every entry point, so a LIVE process or a DB that
 * holds LIVE workspaces or non-demo users is refused before anything is read or written. A seed
 * never runs on top of existing tenant data: reset is an explicit, separate call.
 *
 * Later tasks extend the seed by appending fixture modules and steps here (plan §0 rule 5).
 */
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client';
import type { Clock } from '../../src/lib/clock';
import { assertDemoSeedTarget } from '../../src/server/auth/demo-personas';
import { withTx } from '../../src/server/db/tx';
import { PIPELINE_V1, SCORING_V1 } from './fixtures/configs';
import { ASSIGNMENT_CREATOR, ASSIGNMENT_FIXTURES, MEMBERSHIP_FIXTURES, USER_FIXTURES } from './fixtures/identities';
import { termsFor, WORKSPACE_FIXTURES } from './fixtures/workspaces';
import { seedId } from './ids';

export type SeedOptions = { config: { mode: 'demo' | 'live' }; now: Date };

export type SeedSummary = {
  anchorAt: string;
  workspaces: number;
  users: number;
  memberships: number;
  assignments: number;
  services: number;
};

export class AlreadySeededError extends Error {
  constructor(workspaces: number) {
    super(`The database is already seeded (${workspaces} workspaces). Run \`npm run db:reset\` to wipe and reseed it.`);
    this.name = 'AlreadySeededError';
  }
}

/** Tables a reset never clears: Prisma's migration ledger and live worker process state. */
const KEEP_TABLES = new Set(['_prisma_migrations', 'WorkerHeartbeat']);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** SEED_NOW when configured, otherwise the clock's time floored to the hour (`.env.example`). */
export function seedAnchor(config: { seedNow: Date | null }, clock: Clock): Date {
  if (config.seedNow) return config.seedNow;
  const t = clock.now().getTime();
  return new Date(t - (t % HOUR));
}

export const userId = (key: string) => seedId('user', key);
export const workspaceId = (slug: string) => seedId('workspace', slug);

type Tx = Prisma.TransactionClient;

/** Names of every application table (excluding SQLite internals and KEEP_TABLES). */
export async function applicationTables(db: Pick<PrismaClient, '$queryRawUnsafe'>, opts: { includeKept?: boolean } = {}): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`,
  );
  return rows.map((r) => r.name).filter((n) => n !== '_prisma_migrations' && (opts.includeKept || !KEEP_TABLES.has(n)));
}

async function wipe(tx: Tx): Promise<void> {
  const tables = await applicationTables(tx);
  // Foreign keys are checked at commit, when every table is empty.
  await tx.$executeRawUnsafe('PRAGMA defer_foreign_keys = ON');
  for (const table of tables) await tx.$executeRawUnsafe(`DELETE FROM "${table.replaceAll('"', '""')}"`);
}

async function insertAll(tx: Tx, now: Date): Promise<SeedSummary> {
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const counts = { workspaces: 0, users: 0, memberships: 0, assignments: 0, services: 0 };

  await tx.systemSetting.upsert({
    where: { id: 1 },
    create: { id: 1, outboundPaused: false },
    update: { outboundPaused: false, outboundPausedAt: null, outboundPausedBy: null, outboundPauseReason: null },
  });
  await tx.testClock.upsert({ where: { id: 1 }, create: { id: 1, offsetMs: 0n, frozenAt: null }, update: { offsetMs: 0n, frozenAt: null } });

  for (const u of USER_FIXTURES) {
    await tx.user.create({
      data: {
        id: userId(u.key),
        email: u.email,
        name: u.name,
        globalRole: u.globalRole,
        status: 'ACTIVE',
        passwordHash: null,
        isDemo: true,
        createdAt: ago(u.createdDaysAgo),
        lastLoginAt: u.lastLoginHoursAgo === null ? null : new Date(now.getTime() - u.lastLoginHoursAgo * HOUR),
      },
    });
    counts.users++;
  }

  const ownerOf = new Map(MEMBERSHIP_FIXTURES.filter((m) => m.role === 'OWNER').map((m) => [m.workspace, m.user]));

  for (const ws of WORKSPACE_FIXTURES) {
    const wsId = workspaceId(ws.slug);
    const createdAt = ago(ws.createdDaysAgo);
    const owner = ownerOf.get(ws.slug);
    if (!owner) throw new Error(`seed fixture error: workspace ${ws.slug} has no OWNER membership`);
    const ownerId = userId(owner);

    await tx.workspace.create({
      data: { id: wsId, slug: ws.slug, name: ws.name, mode: 'DEMO', planLabel: ws.planLabel, timezone: 'Asia/Kolkata', status: 'ACTIVE', createdAt },
    });
    const s = ws.settings;
    await tx.workspaceSettings.create({
      data: {
        workspaceId: wsId,
        autoSendEnabled: s.autoSendEnabled,
        emailB2bAttestationEnabled: s.emailB2bAttestationEnabled,
        emailFallbackEnabled: s.emailFallbackEnabled,
        taxMode: s.taxMode,
        taxLabel: s.taxLabel,
        taxBps: s.taxBps,
        maxDiscountBps: s.maxDiscountBps,
        quoteValidityDays: s.quoteValidityDays,
        gstin: null,
        brandColor: s.brandColor,
        logoPath: null,
        termsText: termsFor(ws),
        bookingUrl: s.bookingUrl,
        internalWaDailyCap: s.internalWaDailyCap,
        internalEmailDailyCap: s.internalEmailDailyCap,
        currencyDisplay: 'INR',
        updatedAt: createdAt,
        updatedBy: ownerId,
      },
    });
    counts.workspaces++;

    const pricingVersionId = seedId('pricing-version', `${ws.slug}:1`);
    await tx.pricingVersion.create({
      data: { id: pricingVersionId, workspaceId: wsId, version: 1, active: true, note: 'Initial price list', createdBy: ownerId, createdAt },
    });
    for (const svc of ws.services) {
      const serviceId = seedId('service', `${ws.slug}:${svc.code}`);
      await tx.service.create({
        data: {
          id: serviceId,
          workspaceId: wsId,
          code: svc.code,
          name: svc.name,
          description: svc.description,
          unitLabel: svc.unitLabel,
          defaultTimelineDays: svc.defaultTimelineDays,
          maxDiscountBps: svc.maxDiscountBps,
        },
      });
      await tx.priceEntry.create({
        data: {
          id: seedId('price-entry', `${ws.slug}:1:${svc.code}`),
          workspaceId: wsId,
          pricingVersionId,
          serviceId,
          unitPricePaise: BigInt(svc.unitPriceRupees) * 100n,
          minQty: svc.minQty ?? 1,
          maxQty: svc.maxQty ?? 10000,
        },
      });
      counts.services++;
    }

    await tx.scoringConfigVersion.create({
      data: { id: seedId('scoring-version', `${ws.slug}:1`), workspaceId: wsId, version: 1, weights: SCORING_V1, active: true, createdBy: ownerId, createdAt },
    });
    await tx.pipelineConfigVersion.create({
      data: {
        id: seedId('pipeline-version', `${ws.slug}:1`),
        workspaceId: wsId,
        version: 1,
        graph: PIPELINE_V1,
        approvalMode: 'HUMAN',
        active: true,
        createdBy: ownerId,
        createdAt,
      },
    });
  }

  for (const m of MEMBERSHIP_FIXTURES) {
    await tx.membership.create({
      data: { id: seedId('membership', `${m.user}:${m.workspace}`), userId: userId(m.user), workspaceId: workspaceId(m.workspace), role: m.role, createdAt: ago(m.createdDaysAgo) },
    });
    counts.memberships++;
  }

  for (const a of ASSIGNMENT_FIXTURES) {
    await tx.employeeAssignment.create({
      data: {
        id: seedId('assignment', `${a.employee}:${a.workspace}`),
        employeeUserId: userId(a.employee),
        workspaceId: workspaceId(a.workspace),
        capabilities: [...a.capabilities],
        maxDiscountBps: a.maxDiscountBps,
        active: a.active,
        createdBy: userId(ASSIGNMENT_CREATOR),
        createdAt: ago(a.createdDaysAgo),
      },
    });
    counts.assignments++;
  }

  const summary: SeedSummary = { anchorAt: now.toISOString(), ...counts };
  await tx.auditEvent.create({
    data: {
      id: seedId('audit', 'demo.seed'),
      workspaceId: null,
      actorUserId: null,
      actorKind: 'SYSTEM',
      action: 'demo.seed',
      targetType: 'System',
      targetId: 'demo-seed',
      result: 'SUCCESS',
      summary,
      crossWorkspace: false,
      correlationId: 'seed',
      simulated: true,
      createdAt: now,
    },
  });
  return summary;
}

const TX_OPTIONS = { maxWaitMs: 20_000, timeoutMs: 60_000 } as const;

/** Seeds an empty DEMO database. Throws AlreadySeededError when any workspace exists. */
export async function seedDemo(db: PrismaClient, opts: SeedOptions): Promise<SeedSummary> {
  await assertDemoSeedTarget(opts.config, db);
  return withTx(
    db,
    async (tx: Tx) => {
      const existing = await tx.workspace.count();
      if (existing > 0) throw new AlreadySeededError(existing);
      return insertAll(tx, opts.now);
    },
    TX_OPTIONS,
  );
}

/** Wipes every application table and seeds again, in one transaction (all or nothing). */
export async function resetAndSeedDemo(db: PrismaClient, opts: SeedOptions): Promise<SeedSummary> {
  await assertDemoSeedTarget(opts.config, db);
  return withTx(
    db,
    async (tx: Tx) => {
      // Re-checked inside the write transaction so a concurrent LIVE write cannot slip in.
      await assertDemoSeedTarget(opts.config, tx);
      await wipe(tx);
      return insertAll(tx, opts.now);
    },
    TX_OPTIONS,
  );
}
