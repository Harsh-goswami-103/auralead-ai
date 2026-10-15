/**
 * `npm run db:restore -- --latest --yes` or `npm run db:restore -- --manifest <file.db.json> --yes`
 * (T24, O1, E8). Stop the web app and the worker first (a fresh worker heartbeat refuses unless
 * `--allow-running-worker`). The restore writes `outbound.lock` first, replaces this mode's data
 * with the backup in one transaction, turns sends that were in flight at backup time into
 * AMBIGUOUS ("Delivery unknown"), replays the SuppressionJournal entries newer than the backup, and
 * leaves outbound PAUSED: review the AMBIGUOUS attempts in Platform admin > Jobs, then resume
 * outbound there. Without `--yes` it only prints what it would restore.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { systemClock } from '../src/lib/clock';
import { ConfigError, getConfig } from '../src/lib/config';
import { ensureEnvLoaded } from '../src/lib/env-load';
import { redactText } from '../src/lib/redact';
import { createPrismaClient } from '../src/server/db/client';
import { listBackups, readBackupManifest, restoreBackup } from '../src/server/services/admin/backup';

function arg(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
}

async function main(): Promise<number> {
  ensureEnvLoaded();
  const argv = process.argv.slice(2);
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
  let manifestFile = arg(argv, '--manifest');
  if (!manifestFile && argv.includes('--latest')) manifestFile = (await listBackups(config.paths.backupDir))[0]?.manifestFile ?? null;
  if (!manifestFile) {
    console.error(`Name a backup: --manifest <file.db.json>, or --latest (backups in ${config.paths.backupDir}).`);
    return 1;
  }
  const db = createPrismaClient({ url: config.paths.databaseUrl });
  try {
    const manifest = await readBackupManifest(path.resolve(manifestFile));
    console.log(`Backup ${manifest.file}: mode ${manifest.mode}, taken ${manifest.backupAt}, ${manifest.bytes} bytes.`);
    console.log(`Target: ${config.paths.dbFile}`);
    if (!argv.includes('--yes')) {
      console.log('Dry run. Re-run with --yes to restore (stop the web app and the worker first).');
      return 0;
    }
    const result = await restoreBackup(db, systemClock, {
      manifestFile: path.resolve(manifestFile),
      lockFile: config.paths.outboundLockFile,
      journalDir: config.paths.journalDir,
      mode: config.mode,
      correlationId: 'db-restore',
      allowRunningWorker: argv.includes('--allow-running-worker'),
    });
    console.log(`Restored ${result.rowsRestored} rows in ${result.tablesRestored} tables.`);
    console.log(`In-flight sends marked AMBIGUOUS: ${result.attemptsMadeAmbiguous} (jobs DEAD: ${result.jobsMadeDead}).`);
    console.log(
      `SuppressionJournal: ${result.journal.replayed} newer entries; ${result.journal.stopsInserted} stops and ${result.journal.clearsApplied} clears applied; ${result.journal.skipped} already present.`,
    );
    console.log(`Outbound is PAUSED (${result.lockFile}). Review AMBIGUOUS attempts in Platform admin > Jobs, then resume outbound there.`);
    return 0;
  } catch (error) {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`db:restore failed: ${redactText(text)}`);
    return 1;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
