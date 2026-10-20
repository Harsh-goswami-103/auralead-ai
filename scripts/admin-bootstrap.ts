/**
 * `npm run admin:bootstrap -- --email <address>` (ADR-68): creates the first administrator of a
 * LIVE installation. It prints a single-use invite link (72 hours) that the person opens to choose
 * their own name and password; this script never handles a password. It refuses once an active
 * real SUPER_ADMIN exists. `--recover` instead prints a one-hour password reset link for that
 * existing administrator (lost password). Run it on the server with the LIVE environment, after
 * `npm run db:deploy`. The link is shown once in this terminal only; it is never logged or stored.
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { systemClock } from '../src/lib/clock';
import { ConfigError, getConfig } from '../src/lib/config';
import { ensureEnvLoaded } from '../src/lib/env-load';
import { redactText } from '../src/lib/redact';
import { AdminBootstrapError, bootstrapAdmin } from '../src/server/auth/bootstrap';
import { createPrismaClient } from '../src/server/db/client';

function arg(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : null;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  ensureEnvLoaded();
  const email = arg(argv, '--email');
  if (!email) {
    console.error('Usage: npm run admin:bootstrap -- --email <address> [--recover]');
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
  const db = createPrismaClient({ url: config.paths.databaseUrl });
  try {
    const result = await bootstrapAdmin(db, { email, recover: argv.includes('--recover') }, { mode: config.mode, clock: systemClock, correlationId: `admin-bootstrap-${randomUUID()}` });
    const route = result.kind === 'invite' ? 'invite' : 'reset';
    console.log(result.kind === 'invite' ? `Administrator invite for ${result.email} (single use):` : `Password reset for ${result.email} (single use):`);
    console.log(`${config.appOrigin}/${route}/${result.token}`);
    console.log(`Expires ${result.expiresAt.toISOString()}. Open it in a browser to ${result.kind === 'invite' ? 'set your name and password' : 'choose a new password'}.`);
    return 0;
  } catch (error) {
    if (error instanceof AdminBootstrapError) {
      console.error(error.message);
      return 1;
    }
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`admin:bootstrap failed: ${redactText(text)}`);
    return 1;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
