/**
 * `npm run db:backup` (T24, R42): a consistent copy of this mode's SQLite DB through `VACUUM INTO`
 * (safe while the web and worker run) into BACKUP_DIR (default `<DATA_DIR>/<mode>/backups`), plus a
 * manifest `<file>.json` (mode, backup time, sha256, applied migrations). The SuppressionJournal
 * and STORAGE_DIR (quote PDFs) live outside the DB file: copy STORAGE_DIR alongside if you need
 * the PDFs; the journal is never part of a backup (a restore replays it).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { systemClock } from '../src/lib/clock';
import { ConfigError, getConfig } from '../src/lib/config';
import { ensureEnvLoaded } from '../src/lib/env-load';
import { redactText } from '../src/lib/redact';
import { createPrismaClient } from '../src/server/db/client';
import { createBackup } from '../src/server/services/admin/backup';

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
  for (const warning of config.paths.warnings) console.warn(`warning: ${warning}`);
  const db = createPrismaClient({ url: config.paths.databaseUrl });
  try {
    const { file, manifest } = await createBackup(db, systemClock, { backupDir: config.paths.backupDir, mode: config.mode, correlationId: 'db-backup' });
    console.log(`Backup written: ${file}`);
    console.log(`  taken ${manifest.backupAt}, ${manifest.bytes} bytes, sha256 ${manifest.sha256}, ${manifest.migrations.length} migrations`);
    return 0;
  } catch (error) {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`db:backup failed: ${redactText(text)}`);
    return 1;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
