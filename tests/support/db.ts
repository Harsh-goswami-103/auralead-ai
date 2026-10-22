/**
 * Integration-test DB harness: one real SQLite file per test file in
 * `os.tmpdir()/auralead-test-<runId>/` (plan §1), migrated with the real `prisma migrate deploy`
 * (spawned via `process.execPath`), opened through the production client factory so every test
 * runs with the same adapter and PRAGMAs as the app. `destroy()` disconnects every client and
 * deletes the directory with `fs.rm(..., { maxRetries: 5, retryDelay: 200 })` (Windows locks).
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { PrismaClient } from '@/generated/prisma/client';
import { createPrismaClient } from '@/server/db/client';
import { toSqliteFileUrl } from '@/lib/paths';
import { REPO_ROOT } from './spawn';

export type TestDb = {
  dir: string;
  file: string;
  url: string;
  /** A new Prisma client on this DB (production factory); closed by `destroy()`. */
  client: () => PrismaClient;
  destroy: () => Promise<void>;
};

const PRISMA_CLI = path.join(REPO_ROOT, 'node_modules', 'prisma', 'build', 'index.js');

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** Runs `prisma migrate deploy` against `url` in a child process; throws with its output on failure. */
export function migrateDeploy(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1', CHECKPOINT_DISABLE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (c: Buffer) => (output += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (output += c.toString('utf8')));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`prisma migrate deploy exited ${code}:\n${output}`));
    });
  });
}

export async function createTestDb(options: { label?: string; migrate?: boolean } = {}): Promise<TestDb> {
  const runId = `${options.label ?? 'db'}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const dir = path.join(os.tmpdir(), `auralead-test-${runId}`);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'app.db');
  const url = toSqliteFileUrl(file);
  if (options.migrate !== false) await migrateDeploy(url);

  const clients = new Set<PrismaClient>();
  return {
    dir,
    file,
    url,
    client() {
      const c = createPrismaClient({ url });
      clients.add(c);
      return c;
    },
    async destroy() {
      await Promise.all([...clients].map((c) => c.$disconnect()));
      clients.clear();
      await removeDir(dir);
      if (existsSync(dir)) throw new Error(`test DB dir still present after teardown: ${dir}`);
    },
  };
}
