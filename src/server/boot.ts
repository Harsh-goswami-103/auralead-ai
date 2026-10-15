/**
 * Boot checks and the web process runtime (plan §3 boot.ts, §4.2, §9 "Test control", ADR-04).
 *
 * `checkBoot` refuses to start:
 *  - LIVE with test control enabled (also refused by config parsing; checked again here so a
 *    config object built any other way cannot slip through);
 *  - in either mode without SESSION_SECRET, SHARE_NONCE_KEY, SUPPRESSION_PEPPER or the credentials
 *    key ring. LIVE requires them by policy; DEMO needs them too because CSRF tokens, share-link
 *    nonces, suppression keys and encrypted demo credentials use the same code paths, and
 *    `npm run setup` generates them.
 * Paths inside OneDrive come back as warnings (ADR-20), logged once at startup.
 *
 * `getRuntime()` lazily boots the process once (config, Prisma client, rate limiters, logger)
 * and caches it on globalThis so Next dev reloads reuse one SQLite connection. Tests install
 * their own runtime with `installRuntime`.
 */
import { DbOffsetClock, isTestClockAllowed, systemClock, type Clock } from '@/lib/clock';
import { ConfigError, parseConfig, type AppConfig, type ParseConfigOptions } from '@/lib/config';
import { ensureEnvLoaded } from '@/lib/env-load';
import { createLogger, type Logger } from '@/lib/logger';
import type { PrismaClient } from '@/generated/prisma/client';
import { createPrismaClient } from '@/server/db/client';
import { createRateLimiters, type RateLimiters } from '@/server/security/rate-limit';

export class BootError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Refusing to start:\n  - ${issues.join('\n  - ')}`);
    this.name = 'BootError';
    this.issues = issues;
  }
}

export type BootCheckConfig = Pick<AppConfig, 'mode' | 'testControl' | 'secrets' | 'paths'>;

export function checkBoot(config: BootCheckConfig): { warnings: string[] } {
  const issues: string[] = [];
  if (config.mode === 'live' && config.testControl.enabled) {
    issues.push('AURALEAD_TEST_CONTROL: test control is never allowed in LIVE mode');
  }
  const missing: string[] = [];
  if (!config.secrets.sessionSecret) missing.push('SESSION_SECRET');
  if (!config.secrets.shareNonceKey) missing.push('SHARE_NONCE_KEY');
  if (!config.secrets.suppressionPepper) missing.push('SUPPRESSION_PEPPER');
  if (!config.secrets.credentials) missing.push('CREDENTIALS_KEYRING');
  if (missing.length > 0) issues.push(`${missing.join(', ')}: required; run \`npm run setup\` to generate them into .env`);
  if (issues.length > 0) throw new BootError(issues);
  return { warnings: [...config.paths.warnings] };
}

/** Parses and checks the environment; every problem is reported as one BootError. */
export function bootFromEnv(env: Record<string, string | undefined>, options: ParseConfigOptions = {}): { config: AppConfig; warnings: string[] } {
  let config: AppConfig;
  try {
    config = parseConfig(env, options);
  } catch (error) {
    if (error instanceof ConfigError) throw new BootError(error.issues);
    throw error;
  }
  const { warnings } = checkBoot(config);
  return { config, warnings };
}

export type Runtime = {
  config: AppConfig;
  prisma: PrismaClient;
  limiters: RateLimiters;
  logger: Logger;
  /** The wall clock (tests: a FixedClock). The test-control offset is applied on top per request. */
  baseClock: Clock;
  warnings: string[];
};

const KEY = Symbol.for('auralead.runtime');
type Holder = { [KEY]?: Runtime };
const holder = globalThis as Holder;

export function getRuntime(): Runtime {
  const existing = holder[KEY];
  if (existing) return existing;
  ensureEnvLoaded();
  const { config, warnings } = bootFromEnv(process.env);
  const logger = createLogger({ level: config.logLevel, base: { service: 'web' } });
  for (const warning of warnings) logger.warn({ warning }, 'boot warning');
  const runtime: Runtime = {
    config,
    prisma: createPrismaClient({ url: config.paths.databaseUrl }),
    limiters: createRateLimiters(systemClock),
    logger,
    baseClock: systemClock,
    warnings,
  };
  holder[KEY] = runtime;
  return runtime;
}

export function installRuntime(runtime: Runtime): void {
  holder[KEY] = runtime;
}

export function uninstallRuntime(): void {
  delete holder[KEY];
}

/**
 * The clock for one request: the base clock, shifted by the TestClock row only in DEMO with
 * AURALEAD_TEST_CONTROL=1 and a token (A40). Read once per request so web and worker agree.
 */
export async function requestClock(runtime: Runtime): Promise<Clock> {
  if (!isTestClockAllowed(runtime.config)) return runtime.baseClock;
  const loader = async () => (await runtime.prisma.testClock.findUnique({ where: { id: 1 } })) ?? { offsetMs: 0n, frozenAt: null };
  return DbOffsetClock.load(runtime.config, loader, runtime.baseClock);
}
