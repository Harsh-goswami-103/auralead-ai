/**
 * `npm run creds:rotate` (T32; plan §9 Credentials, ADR-25, ADR-35): re-encrypts every stored
 * secret envelope under the key ring's active kid: Integration credentials (AAD
 * `workspaceId|integrationId|field`) and WebhookEvent processing payloads (AAD = the event id).
 *
 * Rotation procedure (docs/deployment.md, T37): add the new key to CREDENTIALS_KEYRING next to the
 * old one, point CREDENTIALS_ACTIVE_KID at it, stop the web and the worker, run this, and keep the
 * old key in the ring until the report says `remaining under other kids: 0`. Each row is rewritten
 * in its own transaction, so a run is safe to repeat (a second run changes nothing) and safe to
 * interrupt. Nothing secret is printed: the report holds counts, table names, ids and field names.
 * Exit code 0 when no envelope is left under another kid and none was unreadable, else 1.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { systemClock } from '../src/lib/clock';
import { ConfigError, getConfig } from '../src/lib/config';
import { ensureEnvLoaded } from '../src/lib/env-load';
import { redactText } from '../src/lib/redact';
import { createPrismaClient } from '../src/server/db/client';
import { rotateCredentialEnvelopes } from '../src/server/services/integrations/credentials';

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
  const ring = config.secrets.credentials;
  if (!ring) {
    console.error('creds:rotate needs CREDENTIALS_KEYRING and CREDENTIALS_ACTIVE_KID (run `npm run setup`).');
    return 1;
  }
  for (const warning of config.paths.warnings) console.warn(`warning: ${warning}`);
  const db = createPrismaClient({ url: config.paths.databaseUrl });
  try {
    const report = await rotateCredentialEnvelopes(db, ring, { clock: systemClock, correlationId: 'creds-rotate' });
    console.log(`Active kid: ${report.activeKid} (${Object.keys(ring.keys).length} keys in the ring)`);
    console.log(`Integration credentials: ${report.integrations.envelopes} envelopes in ${report.integrations.rows} integrations, ${report.integrations.rotated} re-encrypted`);
    console.log(`Webhook processing payloads: ${report.webhookEvents.rows} stored, ${report.webhookEvents.rotated} re-encrypted`);
    console.log(`Remaining under other kids: ${report.remainingOldKid}`);
    for (const u of report.unreadable) console.log(`Unreadable (left unchanged): ${u.table} ${u.id}${u.field ? ` field ${u.field}` : ''} (${u.reason})`);
    if (report.unreadable.length > 0) console.log('Re-enter the unreadable credentials on their setup pages; their old key is not in the ring.');
    return report.remainingOldKid === 0 && report.unreadable.length === 0 ? 0 : 1;
  } catch (error) {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`creds:rotate failed: ${redactText(text)}`);
    return 1;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
