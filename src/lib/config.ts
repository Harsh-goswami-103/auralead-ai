/**
 * Typed, validated configuration (plan §14, ADR-04). This is one of only two modules allowed
 * to read the app mode variable (the other is src/server/adapters/registry.ts).
 *
 * DEMO: everything has a safe default; secrets are optional here (setup generates them) but
 * validated when present. LIVE: SESSION_SECRET, SHARE_NONCE_KEY, SUPPRESSION_PEPPER and the
 * credentials key ring are required, and test control is refused.
 * Issues never include the offending value, so secrets are not echoed into logs.
 */
import os from 'node:os';
import { z } from 'zod';
import { ensureEnvLoaded } from './env-load';
import { resolvePaths, type AppMode, type ResolvedPaths } from './paths';

export type { AppMode } from './paths';

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const MIN_SECRET_LENGTH = 32;
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Treats unset and blank values the same. */
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const opt = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());
const flag = (name: string) =>
  z.preprocess(
    blankToUndefined,
    z
      .enum(['1', '0', 'true', 'false'], { error: `${name} must be 1, 0, true or false` })
      .optional()
      .transform((v) => v === '1' || v === 'true'),
  );
const secretField = opt(z.string().min(MIN_SECRET_LENGTH, { error: `must be at least ${MIN_SECRET_LENGTH} characters` }));

const rawSchema = z.object({
  APP_MODE: z.preprocess(blankToUndefined, z.enum(['demo', 'live']).default('demo')),
  NEXT_PUBLIC_APP_MODE: opt(z.enum(['demo', 'live'])),
  APP_ORIGIN: z.preprocess(blankToUndefined, z.url({ protocol: /^https?$/ }).default('http://localhost:3000')),
  SESSION_SECRET: secretField,
  SHARE_NONCE_KEY: secretField,
  SUPPRESSION_PEPPER: secretField,
  CREDENTIALS_KEYRING: opt(z.string()),
  CREDENTIALS_ACTIVE_KID: opt(z.string()),
  OUTBOUND_PAUSED: flag('OUTBOUND_PAUSED'),
  AURALEAD_TEST_CONTROL: flag('AURALEAD_TEST_CONTROL'),
  TEST_CONTROL_TOKEN: secretField,
  META_APP_SECRET: opt(z.string()),
  META_VERIFY_TOKEN: opt(z.string()),
  META_GRAPH_VERSION: opt(z.string().regex(/^v\d+\.\d+$/, { error: 'must look like v24.0' })),
  META_MARKETING_VERSION: opt(z.string().regex(/^v\d+\.\d+$/, { error: 'must look like v24.0' })),
  TRUSTED_PROXY_HOPS: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).max(10).default(0)),
  AUTH_COOKIE_INSECURE_DEV: flag('AUTH_COOKIE_INSECURE_DEV'),
  SEED_NOW: opt(z.iso.datetime({ offset: true })),
  LOG_LEVEL: z.preprocess(blankToUndefined, z.enum(LOG_LEVELS).default('info')),
});

export type CredentialKeyRing = { activeKid: string; keys: Record<string, Buffer> };

export type AppConfig = {
  mode: AppMode;
  /** Build-time mode exposed to the client bundle; always equal to `mode`. */
  publicMode: AppMode;
  appOrigin: string;
  logLevel: LogLevel;
  outboundPaused: boolean;
  trustedProxyHops: number;
  authCookieInsecureDev: boolean;
  seedNow: Date | null;
  testControl: { enabled: boolean; token: string | null };
  meta: { appSecret: string | null; verifyToken: string | null; graphVersion: string | null; marketingVersion: string | null };
  secrets: {
    sessionSecret: string | null;
    shareNonceKey: string | null;
    suppressionPepper: string | null;
    credentials: CredentialKeyRing | null;
  };
  paths: ResolvedPaths;
};

export type ParseConfigOptions = {
  platform?: NodeJS.Platform;
  cwd?: string;
  homedir?: string;
};

function parseKeyRing(raw: string | undefined, activeKid: string | undefined, issues: string[]): CredentialKeyRing | null {
  if (raw === undefined && activeKid === undefined) return null;
  if (raw === undefined) {
    issues.push('CREDENTIALS_KEYRING: required when CREDENTIALS_ACTIVE_KID is set');
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    issues.push('CREDENTIALS_KEYRING: must be JSON like {"k1":"<base64 of 32 bytes>"}');
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    issues.push('CREDENTIALS_KEYRING: must be a non-empty JSON object of kid -> base64 key');
    return null;
  }
  const keys: Record<string, Buffer> = {};
  for (const [kid, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(kid)) {
      issues.push('CREDENTIALS_KEYRING: kid names may only contain letters, digits, _ and -');
      continue;
    }
    const key = typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.alloc(0);
    if (key.length !== 32) {
      issues.push(`CREDENTIALS_KEYRING: key "${kid}" must be base64 of exactly 32 bytes`);
      continue;
    }
    keys[kid] = key;
  }
  if (activeKid === undefined) {
    issues.push('CREDENTIALS_ACTIVE_KID: required when CREDENTIALS_KEYRING is set');
    return null;
  }
  if (!(activeKid in keys)) {
    issues.push('CREDENTIALS_ACTIVE_KID: must name a key present in CREDENTIALS_KEYRING');
    return null;
  }
  return { activeKid, keys };
}

export function parseConfig(env: Record<string, string | undefined>, options: ParseConfigOptions = {}): AppConfig {
  const result = rawSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const r = result.data;
  const issues: string[] = [];

  if (r.NEXT_PUBLIC_APP_MODE !== undefined && r.NEXT_PUBLIC_APP_MODE !== r.APP_MODE) {
    issues.push('NEXT_PUBLIC_APP_MODE: must equal APP_MODE (one process serves one mode)');
  }
  if (r.AURALEAD_TEST_CONTROL && r.TEST_CONTROL_TOKEN === undefined) {
    issues.push(`TEST_CONTROL_TOKEN: required (at least ${MIN_SECRET_LENGTH} characters) when AURALEAD_TEST_CONTROL=1`);
  }

  const credentials = parseKeyRing(r.CREDENTIALS_KEYRING, r.CREDENTIALS_ACTIVE_KID, issues);

  if (r.APP_MODE === 'live') {
    const required: Array<[string, unknown]> = [
      ['SESSION_SECRET', r.SESSION_SECRET],
      ['SHARE_NONCE_KEY', r.SHARE_NONCE_KEY],
      ['SUPPRESSION_PEPPER', r.SUPPRESSION_PEPPER],
      ['CREDENTIALS_KEYRING', r.CREDENTIALS_KEYRING],
      ['CREDENTIALS_ACTIVE_KID', r.CREDENTIALS_ACTIVE_KID],
    ];
    for (const [name, value] of required) {
      if (value === undefined) issues.push(`${name}: required in LIVE mode`);
    }
    if (r.AURALEAD_TEST_CONTROL) issues.push('AURALEAD_TEST_CONTROL: must not be enabled in LIVE mode');
  }

  let paths: ResolvedPaths | null = null;
  try {
    paths = resolvePaths({
      mode: r.APP_MODE,
      env,
      platform: options.platform ?? process.platform,
      cwd: options.cwd ?? process.cwd(),
      homedir: options.homedir ?? os.homedir(),
    });
  } catch (error) {
    issues.push((error as Error).message);
  }

  if (issues.length > 0 || paths === null) throw new ConfigError(issues);

  return {
    mode: r.APP_MODE,
    publicMode: r.APP_MODE,
    appOrigin: r.APP_ORIGIN.replace(/\/+$/, ''),
    logLevel: r.LOG_LEVEL,
    outboundPaused: r.OUTBOUND_PAUSED,
    trustedProxyHops: r.TRUSTED_PROXY_HOPS,
    authCookieInsecureDev: r.AUTH_COOKIE_INSECURE_DEV,
    seedNow: r.SEED_NOW === undefined ? null : new Date(r.SEED_NOW),
    testControl: { enabled: r.AURALEAD_TEST_CONTROL, token: r.TEST_CONTROL_TOKEN ?? null },
    meta: {
      appSecret: r.META_APP_SECRET ?? null,
      verifyToken: r.META_VERIFY_TOKEN ?? null,
      graphVersion: r.META_GRAPH_VERSION ?? null,
      marketingVersion: r.META_MARKETING_VERSION ?? null,
    },
    secrets: {
      sessionSecret: r.SESSION_SECRET ?? null,
      shareNonceKey: r.SHARE_NONCE_KEY ?? null,
      suppressionPepper: r.SUPPRESSION_PEPPER ?? null,
      credentials,
    },
    paths,
  };
}

let cached: AppConfig | null = null;

/** Loads `.env` (real env wins) and returns the validated process config, memoized. */
export function getConfig(): AppConfig {
  if (cached) return cached;
  ensureEnvLoaded();
  cached = parseConfig(process.env);
  return cached;
}
