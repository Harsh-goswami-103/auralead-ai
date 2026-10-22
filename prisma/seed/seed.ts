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
 *
 * ADR-126: the last step writes the presentation pack of codecraft-web (fixtures/presentation.ts):
 * its WhatsApp templates, finder run, leads, opt-ins, chats and handoff. Consent and conversation
 * rows carry contact HMACs, so the seed uses the configured SUPPRESSION_PEPPER
 * (`config.secrets.suppressionPepper`) and the same anchor and pepper give the same content. Without
 * a pepper (a bare `{ mode }` config, as most test harnesses pass) a fixed stand-in keys those
 * rows; the app cannot compute any contact key without a pepper, so nothing reads them then.
 */
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client';
import type { Clock } from '../../src/lib/clock';
import { assertDemoSeedTarget } from '../../src/server/auth/demo-personas';
import { withTx } from '../../src/server/db/tx';
import { PIPELINE_V1, SCORING_V1 } from './fixtures/configs';
import { ASSIGNMENT_CREATOR, ASSIGNMENT_FIXTURES, MEMBERSHIP_FIXTURES, USER_FIXTURES } from './fixtures/identities';
import { termsFor, WORKSPACE_FIXTURES } from './fixtures/workspaces';
import { QUOTE_FIXTURES } from './fixtures/quotes';
import { insertSharedQuotes } from './fixtures/shared-quotes';
import { insertPresentation } from './fixtures/insert-presentation';
import { computeQuoteTotals as computeQuoteMoney } from '../../src/lib/money';
import { seedId } from './ids';

export type SeedOptions = { config: { mode: 'demo' | 'live'; secrets?: { suppressionPepper: string | null } }; now: Date };

/** Keys the presentation pack's consent and chat rows when no SUPPRESSION_PEPPER is configured (see above). */
export const SEED_PEPPER_STAND_IN = 'auralead-demo-seed-without-a-configured-pepper';

function seedPepper(config: SeedOptions['config']): string {
  return config.secrets?.suppressionPepper ?? SEED_PEPPER_STAND_IN;
}

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

async function insertAll(tx: Tx, now: Date, contactKeyPepper: string): Promise<SeedSummary> {
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
        whatsappOptInNotice: s.whatsappOptInNotice ?? null,
        privacyContact: s.privacyContact ?? null,
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
      data: { id: seedId('scoring-version', `${ws.slug}:1`), workspaceId: wsId, version: 1, weights: (ws.scoring ?? SCORING_V1) as Prisma.InputJsonValue, active: true, createdBy: ownerId, createdAt },
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

  await insertQuotes(tx, now);
  // T16: a revised, sent and shared quote for the public quote page (fixtures/shared-quotes.ts).
  await insertSharedQuotes(tx, now);
  // ADR-126: the presentation pack of codecraft-web (fixtures/presentation.ts).
  await insertPresentation(tx, now, { contactKeyPepper });

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

/** T15: demo quotes (DRAFT v1 with items, PENDING approval and creation audit), priced from price list v1. */
async function insertQuotes(tx: Tx, now: Date): Promise<void> {
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  for (const q of QUOTE_FIXTURES) {
    const ws = WORKSPACE_FIXTURES.find((w) => w.slug === q.workspace);
    if (!ws) throw new Error(`seed fixture error: quote ${q.key} names unknown workspace ${q.workspace}`);
    const wsId = workspaceId(ws.slug);
    const ownerId = userId(q.ownerKey);
    const leadId = seedId('lead', q.key);
    const quoteId = seedId('quote', q.key);
    const versionId = seedId('quote-version', `${q.key}:1`);
    const pricingVersionId = seedId('pricing-version', `${ws.slug}:1`);
    const createdAt = ago(q.createdDaysAgo);
    const validUntil = new Date(createdAt.getTime() + ws.settings.quoteValidityDays * DAY);

    const lines = q.items.map((item, position) => {
      const svc = ws.services.find((s) => s.code === item.code);
      if (!svc) throw new Error(`seed fixture error: quote ${q.key} names unknown service ${item.code}`);
      return { svc, qty: item.qty, unitPricePaise: BigInt(svc.unitPriceRupees) * 100n, position };
    });
    const tax = ws.settings.taxMode === 'CONFIGURED' && ws.settings.taxBps !== null ? ({ mode: 'CONFIGURED', bps: ws.settings.taxBps } as const) : ({ mode: 'NONE' } as const);
    const money = computeQuoteMoney({ lines, discount: { kind: 'NONE', value: 0n }, tax });
    const limit = lines.reduce<number>((min, l) => (l.svc.maxDiscountBps === null ? min : Math.min(min, l.svc.maxDiscountBps)), ws.settings.maxDiscountBps);

    await tx.lead.create({
      data: {
        id: leadId,
        workspaceId: wsId,
        displayName: q.lead.name,
        nameNormalized: q.lead.name.toLowerCase(),
        category: q.lead.category,
        city: q.lead.city,
        alternatePhones: [],
        scoreReasons: [],
        unknownInputs: [],
        firstSource: 'MANUAL',
        createdAt: ago(q.lead.createdDaysAgo),
        updatedAt: ago(q.lead.createdDaysAgo),
      },
    });
    await tx.quote.create({ data: { id: quoteId, workspaceId: wsId, leadId, number: q.number, status: 'DRAFT', createdBy: ownerId, createdAt, updatedAt: createdAt } });
    await tx.quoteVersion.create({
      data: {
        id: versionId,
        workspaceId: wsId,
        quoteId,
        versionNo: 1,
        pricingVersionId,
        snapshot: {
          pricingVersionId,
          pricingVersion: 1,
          services: lines.map((l) => ({
            serviceId: seedId('service', `${ws.slug}:${l.svc.code}`),
            code: l.svc.code,
            name: l.svc.name,
            unitLabel: l.svc.unitLabel,
            unitPricePaise: l.unitPricePaise.toString(),
            minQty: l.svc.minQty ?? 1,
            maxQty: l.svc.maxQty ?? 10000,
            maxDiscountBps: l.svc.maxDiscountBps,
          })),
          rules: {
            workspaceMaxDiscountBps: ws.settings.maxDiscountBps,
            effectiveDiscountLimitBps: limit,
            taxMode: tax.mode,
            taxLabel: tax.mode === 'CONFIGURED' ? ws.settings.taxLabel : null,
            taxBps: tax.mode === 'CONFIGURED' ? tax.bps : null,
            quoteValidityDays: ws.settings.quoteValidityDays,
            gstin: null,
            sanityCapPaise: '100000000000',
          },
        },
        scopeText: q.scopeText,
        timelineText: q.timelineText,
        discountKind: 'NONE',
        discountValue: 0n,
        taxLabel: tax.mode === 'CONFIGURED' ? ws.settings.taxLabel : null,
        taxBps: tax.mode === 'CONFIGURED' ? tax.bps : null,
        subtotalPaise: money.subtotalPaise,
        discountPaise: money.discountPaise,
        taxablePaise: money.taxablePaise,
        taxPaise: money.taxPaise,
        totalPaise: money.totalPaise,
        validUntil,
        aiPolicyFlags: [],
        reviewReasons: [],
        createdBy: ownerId,
        createdAt,
        items: {
          create: lines.map((l, i) => ({
            id: seedId('quote-item', `${q.key}:1:${l.position}`),
            serviceId: seedId('service', `${ws.slug}:${l.svc.code}`),
            serviceNameSnapshot: l.svc.name,
            unitLabel: l.svc.unitLabel,
            qty: l.qty,
            unitPricePaise: l.unitPricePaise,
            lineTotalPaise: money.lines[i]!.lineTotalPaise,
            position: l.position,
          })),
        },
      },
    });
    await tx.quote.update({ where: { id: quoteId }, data: { currentVersionId: versionId, currentVersionNo: 1, validUntil, needsPricingReview: false, updatedAt: createdAt } });
    await tx.approval.create({
      data: { id: seedId('approval', `${q.key}:1`), workspaceId: wsId, kind: 'QUOTE_VERSION', status: 'PENDING', quoteId, quoteVersionId: versionId, flags: [], requestedAt: createdAt },
    });
    await tx.auditEvent.create({
      data: {
        id: seedId('audit', `quote.create:${q.key}`),
        workspaceId: wsId,
        actorUserId: ownerId,
        actorKind: 'USER',
        action: 'quote.create',
        targetType: 'Quote',
        targetId: quoteId,
        result: 'SUCCESS',
        summary: { number: q.number, versionNo: 1, lines: lines.length, unpriced: 0, needsPricingReview: false, pricingVersion: 1, fromDraft: false, aiPolicyFlags: [] },
        crossWorkspace: false,
        correlationId: 'seed',
        simulated: true,
        createdAt,
      },
    });
  }
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
      return insertAll(tx, opts.now, seedPepper(opts.config));
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
      return insertAll(tx, opts.now, seedPepper(opts.config));
    },
    TX_OPTIONS,
  );
}
