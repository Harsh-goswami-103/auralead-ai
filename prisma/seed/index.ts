/**
 * Seed entry: `npm run db:seed` (also `prisma db seed`) and `npm run db:reset` (`--reset`).
 * Loads `.env` through the single loader (E12), validates config, opens the DB the app and worker
 * resolve, and seeds the DEMO fixtures. Exit codes: 0 seeded or already seeded, 1 refused or
 * failed. The anchor time is SEED_NOW, or the current time floored to the hour.
 */
import { systemClock } from '../../src/lib/clock';
import { ConfigError, getConfig } from '../../src/lib/config';
import { ensureEnvLoaded } from '../../src/lib/env-load';
import { redactText } from '../../src/lib/redact';
import { createPrismaClient } from '../../src/server/db/client';
import { AlreadySeededError, resetAndSeedDemo, seedAnchor, seedDemo } from './seed';

async function main(argv: string[]): Promise<number> {
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
  const reset = argv.includes('--reset');
  const now = seedAnchor(config, systemClock);
  const db = createPrismaClient({ url: config.paths.databaseUrl });
  try {
    const summary = reset ? await resetAndSeedDemo(db, { config, now }) : await seedDemo(db, { config, now });
    console.log(
      `${reset ? 'Reset and seeded' : 'Seeded'} ${summary.workspaces} workspaces, ${summary.users} users, ${summary.services} services ` +
        `(anchor ${summary.anchorAt}) into ${config.paths.dbFile}`,
    );
    return 0;
  } catch (error) {
    if (error instanceof AlreadySeededError) {
      console.log(error.message);
      return 0;
    }
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`Seed failed: ${redactText(text)}`);
    return 1;
  } finally {
    await db.$disconnect();
  }
}

process.exitCode = await main(process.argv.slice(2));
