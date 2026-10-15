/**
 * Pending-migration check (plan §4.3: the worker refuses to start with pending migrations).
 * Compares the migration folders on disk with the rows Prisma Migrate recorded as finished and not
 * rolled back in `_prisma_migrations`.
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { RawQueryable } from '@/server/db/client';

export class PendingMigrationsError extends Error {
  readonly pending: string[];
  constructor(pending: string[]) {
    super(`refusing to start: ${pending.length} pending migrations (${pending.join(', ')}); run npm run db:deploy`);
    this.name = 'PendingMigrationsError';
    this.pending = pending;
  }
}

export function listMigrationNames(migrationsDir: string): string[] {
  if (!existsSync(migrationsDir)) throw new Error(`migrations directory not found: ${migrationsDir}`);
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(migrationsDir, d.name, 'migration.sql')))
    .map((d) => d.name)
    .sort();
}

export async function findPendingMigrations(db: RawQueryable, migrationsDir: string): Promise<string[]> {
  const expected = listMigrationNames(migrationsDir);
  const table = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" = '_prisma_migrations'`,
  );
  if (table.length === 0) return expected;
  const applied = await db.$queryRawUnsafe<Array<{ migration_name: string }>>(
    `SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`,
  );
  const done = new Set(applied.map((r) => r.migration_name));
  return expected.filter((name) => !done.has(name));
}
