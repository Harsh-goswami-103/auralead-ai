/**
 * Worker process boot (plan §4.3, E12): load `.env` through the single loader, validate config,
 * open the DB with the production client factory, refuse to start with pending migrations, pick
 * the clock (DbOffsetClock only in DEMO + AURALEAD_TEST_CONTROL=1 + TEST_CONTROL_TOKEN), and run
 * the loop with SIGINT, SIGTERM and SIGBREAK wired to a graceful stop.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@/generated/prisma/client';
import { DbOffsetClock, isTestClockAllowed, systemClock, type Clock, type TestClockState } from '@/lib/clock';
import { getConfig } from '@/lib/config';
import { ensureEnvLoaded } from '@/lib/env-load';
import { createLogger } from '@/lib/logger';
import { createPrismaClient } from '@/server/db/client';
import type { JobRegistry } from '@/server/jobs/registry';
import type { JobEvent } from '@/server/jobs/types';
import { findPendingMigrations, PendingMigrationsError } from './migrations';
import { createWorker, type Worker, type WorkerTuning } from './worker';

export type StartWorkerOptions = {
  registry: JobRegistry;
  tuning?: Partial<WorkerTuning>;
  onEvent?: (event: JobEvent) => void;
  startGate?: Promise<void>;
  installSignalHandlers?: boolean;
  cwd?: string;
};

export type WorkerProcess = {
  worker: Worker;
  db: PrismaClient;
  /** Resolves after the loop ended (or the shutdown grace elapsed) and the DB is closed. */
  done: Promise<void>;
  shutdown(reason: string): Promise<void>;
};

function readVersion(cwd: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function startWorkerProcess(options: StartWorkerOptions): Promise<WorkerProcess> {
  ensureEnvLoaded();
  const config = getConfig();
  const cwd = options.cwd ?? process.cwd();
  const logger = createLogger({ level: config.logLevel, base: { service: 'worker' } });
  for (const warning of config.paths.warnings) logger.warn(warning);

  const db = createPrismaClient({ url: config.paths.databaseUrl });
  const pending = await findPendingMigrations(db, path.join(cwd, 'prisma', 'migrations'));
  if (pending.length > 0) {
    const error = new PendingMigrationsError(pending);
    logger.fatal({ pending }, error.message);
    await db.$disconnect();
    throw error;
  }

  let clock: Clock = systemClock;
  let refreshClock: (() => Promise<void>) | undefined;
  if (isTestClockAllowed(config)) {
    const loader = async (): Promise<TestClockState> => {
      const row = await db.testClock.findUnique({ where: { id: 1 } });
      return row ? { offsetMs: row.offsetMs, frozenAt: row.frozenAt } : { offsetMs: 0, frozenAt: null };
    };
    const offsetClock = await DbOffsetClock.load(config, loader);
    clock = offsetClock;
    refreshClock = () => offsetClock.refresh();
    logger.warn('test control clock active (DEMO + AURALEAD_TEST_CONTROL)');
  }

  const worker = createWorker(
    { db, clock, refreshClock, registry: options.registry, logger, mode: config.mode, version: readVersion(cwd), onEvent: options.onEvent, startGate: options.startGate },
    options.tuning,
  );

  // `done` resolves when the loop ends by itself or when a requested stop has returned (the stop
  // waits for the job in flight, bounded by the shutdown grace).
  let resolveStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  let stopRequested: Promise<void> | null = null;
  const shutdown = (reason: string): Promise<void> => {
    stopRequested ??= worker.stop(reason).then(resolveStopped);
    return stopRequested;
  };
  if (options.installSignalHandlers !== false) {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
      process.once(signal, () => void shutdown(signal));
    }
  }

  const running = worker.run();
  const done = Promise.race([running, stopped]).finally(() => db.$disconnect());
  return { worker, db, done, shutdown };
}
