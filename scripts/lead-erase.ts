/**
 * `npm run lead:erase -- --workspace <slug> --lead <leadId> --reason "<request reference>" --yes`
 * (T24): erases one lead's personal data (and the leads merged into it). Suppression rows and their
 * contact HMAC stay, so the person remains opted out; `contactPlain` is nulled. One `lead.erase`
 * audit tombstone with counts and the reason is written. It holds no personal data, so keep the
 * reason to a request reference. Without `--yes` it only prints the lead it would erase.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { systemClock } from '../src/lib/clock';
import { ConfigError, getConfig } from '../src/lib/config';
import { ensureEnvLoaded } from '../src/lib/env-load';
import { redactText } from '../src/lib/redact';
import { createPrismaClient } from '../src/server/db/client';
import { eraseLead } from '../src/server/services/admin/lead-erase';

function arg(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
}

async function main(): Promise<number> {
  ensureEnvLoaded();
  const argv = process.argv.slice(2);
  const slug = arg(argv, '--workspace');
  const leadId = arg(argv, '--lead');
  const reason = arg(argv, '--reason');
  if (!slug || !leadId || !reason) {
    console.error('Usage: npm run lead:erase -- --workspace <slug> --lead <leadId> --reason "<request reference>" --yes');
    return 1;
  }
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
  const pepper = config.secrets.suppressionPepper;
  if (!pepper) {
    console.error('SUPPRESSION_PEPPER is required (run npm run setup).');
    return 1;
  }
  const db = createPrismaClient({ url: config.paths.databaseUrl });
  try {
    const workspace = await db.workspace.findUnique({ where: { slug }, select: { id: true, name: true } });
    const lead = workspace ? await db.lead.findFirst({ where: { id: leadId, workspaceId: workspace.id }, select: { id: true } }) : null;
    if (!workspace || !lead) {
      console.error('No such lead in that workspace.');
      return 1;
    }
    if (!argv.includes('--yes')) {
      console.log(`Would erase lead ${lead.id} of ${workspace.name} (and the leads merged into it). Re-run with --yes.`);
      return 0;
    }
    const result = await eraseLead(db, systemClock, {
      workspaceId: workspace.id,
      leadId: lead.id,
      reason,
      contactKeyPepper: pepper,
      storageDir: config.paths.storageDir,
      correlationId: 'lead-erase',
    });
    console.log(`Erased ${result.leadIds.length} lead row(s); suppressions kept: ${result.suppressionsKept}; jobs cancelled: ${result.jobsCancelled}; files deleted: ${result.filesDeleted}.`);
    console.log(
      Object.entries(result.counts)
        .map(([k, v]) => `${k} ${v}`)
        .join(', '),
    );
    return 0;
  } catch (error) {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`lead:erase failed: ${redactText(text)}`);
    return 1;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
