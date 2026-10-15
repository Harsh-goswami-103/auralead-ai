/**
 * `npm run demo:refresh` (P20): re-bases the DEMO fixture times to a new anchor (SEED_NOW, or the
 * current time floored to the hour) without changing any id. The previous anchor is read from
 * the latest `demo.seed` / `demo.refresh` audit row; every column in REBASE_COLUMNS moves by the
 * difference, and a `demo.refresh` audit row records the change. Refuses LIVE exactly like the
 * seed. T24 extends REBASE_COLUMNS with the window and expiry fixtures.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Prisma, PrismaClient } from '../src/generated/prisma/client';
import { systemClock } from '../src/lib/clock';
import { ConfigError, getConfig } from '../src/lib/config';
import { ensureEnvLoaded } from '../src/lib/env-load';
import { redactText } from '../src/lib/redact';
import { assertDemoSeedTarget } from '../src/server/auth/demo-personas';
import { createPrismaClient } from '../src/server/db/client';
import { withTx } from '../src/server/db/tx';
import { seedId } from '../prisma/seed/ids';
import { REBASE_COLUMNS, REBASE_KEYS } from '../prisma/seed/rebase';
import { seedAnchor } from '../prisma/seed/seed';

export type RefreshResult = { from: string; to: string; shiftMs: number; rowsShifted: number; seq: number };

export class NotSeededError extends Error {
  constructor() {
    super('No demo seed anchor found: run `npm run db:seed` (or `npm run db:reset`) first.');
    this.name = 'NotSeededError';
  }
}

type AnchorSummary = { anchorAt?: unknown; seq?: unknown };
const q = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function latestAnchor(tx: Prisma.TransactionClient): Promise<{ anchorAt: Date; seq: number }> {
  const rows = await tx.auditEvent.findMany({ where: { action: { in: ['demo.seed', 'demo.refresh'] } }, select: { summary: true } });
  let best: { anchorAt: Date; seq: number } | null = null;
  for (const row of rows) {
    const s = row.summary as AnchorSummary;
    if (typeof s.anchorAt !== 'string') continue;
    const seq = typeof s.seq === 'number' ? s.seq : 0;
    if (!best || seq > best.seq) best = { anchorAt: new Date(s.anchorAt), seq };
  }
  if (!best) throw new NotSeededError();
  return best;
}

export async function refreshDemo(db: PrismaClient, opts: { config: { mode: 'demo' | 'live' }; now: Date }): Promise<RefreshResult> {
  await assertDemoSeedTarget(opts.config, db);
  return withTx(
    db,
    async (tx: Prisma.TransactionClient) => {
      await assertDemoSeedTarget(opts.config, tx);
      const previous = await latestAnchor(tx);
      const shiftMs = opts.now.getTime() - previous.anchorAt.getTime();
      let rowsShifted = 0;
      if (shiftMs !== 0) {
        for (const [table, columns] of Object.entries(REBASE_COLUMNS)) {
          const key = REBASE_KEYS[table] ?? 'id';
          const rows = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT ${[key, ...columns].map(q).join(', ')} FROM ${q(table)}`);
          for (const row of rows) {
            const sets: string[] = [];
            const values: unknown[] = [];
            for (const column of columns) {
              const value = row[column];
              if (value === null || value === undefined) continue;
              sets.push(`${q(column)} = ?`);
              values.push(new Date(new Date(value as string | Date).getTime() + shiftMs));
            }
            if (sets.length === 0) continue;
            await tx.$executeRawUnsafe(`UPDATE ${q(table)} SET ${sets.join(', ')} WHERE ${q(key)} = ?`, ...values, row[key]);
            rowsShifted++;
          }
        }
      }
      const seq = previous.seq + 1;
      const result: RefreshResult = { from: previous.anchorAt.toISOString(), to: opts.now.toISOString(), shiftMs, rowsShifted, seq };
      await tx.auditEvent.create({
        data: {
          id: seedId('audit', `demo.refresh:${seq}`),
          actorKind: 'SYSTEM',
          action: 'demo.refresh',
          targetType: 'System',
          targetId: 'demo-seed',
          result: 'SUCCESS',
          summary: { anchorAt: result.to, previousAnchorAt: result.from, shiftMs, rowsShifted, seq },
          correlationId: 'demo-refresh',
          simulated: true,
          createdAt: opts.now,
        },
      });
      return result;
    },
    { maxWaitMs: 20_000, timeoutMs: 60_000 },
  );
}

async function main(): Promise<number> {
  ensureEnvLoaded();
  let config;
  try {
    config = getConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
  const db = createPrismaClient({ url: config.paths.databaseUrl });
  try {
    const r = await refreshDemo(db, { config, now: seedAnchor(config, systemClock) });
    console.log(`Re-based ${r.rowsShifted} rows from ${r.from} to ${r.to} (shift ${r.shiftMs} ms); ids unchanged.`);
    return 0;
  } catch (error) {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`demo:refresh failed: ${redactText(text)}`);
    return 1;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
