/**
 * The single env loader (E12, ADR-44). `.env` (written by `npm run setup`) is the only env file.
 * Variables already present in the real environment always win, including ones set to "".
 * Called first by next.config.ts, prisma.config.ts, worker/index.ts, prisma/seed/index.ts and
 * every script.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';

export type LoadEnvOptions = {
  /** Defaults to `<cwd>/.env`. */
  path?: string;
  /** Defaults to `process.env`; mutated in place. */
  env?: Record<string, string | undefined>;
};

export type LoadEnvResult = {
  path: string;
  found: boolean;
  /** Keys copied from the file (those not already set). */
  applied: string[];
};

export function loadEnvFile(options: LoadEnvOptions = {}): LoadEnvResult {
  const file = options.path ?? path.resolve(process.cwd(), '.env');
  const env = options.env ?? process.env;

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: file, found: false, applied: [] };
    throw error;
  }

  const parsed = parse(text);
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (Object.prototype.hasOwnProperty.call(env, key) && env[key] !== undefined) continue;
    env[key] = value;
    applied.push(key);
  }
  return { path: file, found: true, applied };
}

let loadedOnce: LoadEnvResult | null = null;

/** Idempotent process-wide load of `<cwd>/.env` into `process.env`. */
export function ensureEnvLoaded(): LoadEnvResult {
  loadedOnce ??= loadEnvFile();
  return loadedOnce;
}
