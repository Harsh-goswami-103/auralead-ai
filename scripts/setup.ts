/**
 * `npm run setup` (E12, ADR-44): writes `.env` from `.env.example`, generating local demo
 * secrets for blank secret keys. Never overwrites a key that already exists in `.env`; missing
 * keys are appended. Running it twice changes nothing.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'dotenv';
import { ConfigError, parseConfig } from '../src/lib/config';
import { loadEnvFile } from '../src/lib/env-load';

export const GENERATED_SECRET_KEYS = [
  'SESSION_SECRET',
  'SHARE_NONCE_KEY',
  'SUPPRESSION_PEPPER',
  'CREDENTIALS_KEYRING',
  'TEST_CONTROL_TOKEN',
] as const;

type GeneratedKey = (typeof GENERATED_SECRET_KEYS)[number];

export type SetupOptions = { examplePath: string; envPath: string };
export type SetupResult = { envPath: string; created: boolean; added: string[]; kept: string[] };

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function generate(key: GeneratedKey, activeKid: string): string {
  if (key === 'CREDENTIALS_KEYRING') {
    // Single-quoted so dotenv keeps the JSON verbatim.
    return `'${JSON.stringify({ [activeKid]: randomBytes(32).toString('base64') })}'`;
  }
  return randomBytes(32).toString('base64url');
}

function isGenerated(key: string): key is GeneratedKey {
  return (GENERATED_SECRET_KEYS as readonly string[]).includes(key);
}

export function runSetup({ examplePath, envPath }: SetupOptions): SetupResult {
  const exampleText = readFileSync(examplePath, 'utf8');
  const example = parse(exampleText);
  const envExists = existsSync(envPath);
  const existingText = envExists ? readFileSync(envPath, 'utf8') : '';
  const existing = parse(existingText);
  const activeKid = existing.CREDENTIALS_ACTIVE_KID || example.CREDENTIALS_ACTIVE_KID || 'k1';

  const added: string[] = [];
  const kept = Object.keys(example).filter((k) => k in existing);
  const outLines: string[] = [];

  for (const line of exampleText.split(/\r?\n/)) {
    const match = KEY_LINE.exec(line);
    if (!match) {
      if (!envExists) outLines.push(line);
      continue;
    }
    const key = match[1] as string;
    if (key in existing || added.includes(key)) continue;
    const exampleValue = example[key] ?? '';
    const value = isGenerated(key) && exampleValue === '' ? generate(key, activeKid) : null;
    outLines.push(value === null ? line : `${key}=${value}`);
    added.push(key);
  }

  if (!envExists) {
    writeFileSync(envPath, `${outLines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
    return { envPath, created: true, added, kept };
  }
  if (added.length > 0) {
    const sep = existingText === '' || existingText.endsWith('\n') ? '' : '\n';
    writeFileSync(envPath, `${existingText}${sep}\n# Added by npm run setup\n${outLines.join('\n')}\n`);
  }
  return { envPath, created: false, added, kept };
}

function main(): void {
  const cwd = process.cwd();
  const result = runSetup({ examplePath: path.join(cwd, '.env.example'), envPath: path.join(cwd, '.env') });
  console.log(
    result.created
      ? `Created ${result.envPath} with ${result.added.length} keys.`
      : `Updated ${result.envPath}: ${result.added.length} keys added, ${result.kept.length} existing keys kept.`,
  );
  if (result.added.length > 0) console.log(`Added: ${result.added.join(', ')}`);

  loadEnvFile({ path: result.envPath });
  try {
    const config = parseConfig(process.env);
    console.log(`Mode: ${config.mode}`);
    console.log(`Database: ${config.paths.dbFile}`);
    for (const warning of config.paths.warnings) console.warn(`WARNING: ${warning}`);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
