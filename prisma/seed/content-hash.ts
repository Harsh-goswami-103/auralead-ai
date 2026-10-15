/**
 * A content hash of the whole application database (R43): every row of every application table,
 * serialized canonically (keys sorted, bigint as decimal text, dates as ISO text) and sorted, so
 * the hash depends only on content, never on insertion order or physical layout. Prisma's
 * migration ledger and the worker heartbeat (process state, not data) are excluded.
 */
import { createHash } from 'node:crypto';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { applicationTables } from './seed';

export type ContentHash = { hash: string; rows: number; tables: Record<string, number> };

function canonical(value: unknown): unknown {
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, canonical(obj[k])]),
    );
  }
  return value;
}

export async function contentHash(db: Pick<PrismaClient, '$queryRawUnsafe'>, opts: { excludeTables?: string[] } = {}): Promise<ContentHash> {
  const exclude = new Set(opts.excludeTables ?? []);
  const tables = (await applicationTables(db)).filter((t) => !exclude.has(t));
  const outer = createHash('sha256');
  const counts: Record<string, number> = {};
  let total = 0;
  for (const table of tables) {
    const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT * FROM "${table.replaceAll('"', '""')}"`);
    const lines = rows.map((r) => JSON.stringify(canonical(r))).sort();
    counts[table] = lines.length;
    total += lines.length;
    outer.update(`${table}\n${lines.join('\n')}\n\n`);
  }
  return { hash: outer.digest('hex'), rows: total, tables: counts };
}
