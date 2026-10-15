import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnvFile } from '@/lib/env-load';
import { runSetup, GENERATED_SECRET_KEYS } from '../../../scripts/setup';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

let dir: string;

beforeEach(() => {
  // A space in the temp dir mirrors the repo path ("mini project").
  dir = mkdtempSync(path.join(os.tmpdir(), 'auralead env test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('loadEnvFile', () => {
  it('applies .env values that are not already set', () => {
    const file = path.join(dir, '.env');
    writeFileSync(file, 'APP_MODE=demo\nLOG_LEVEL=debug\n');
    const env: Record<string, string | undefined> = {};

    const result = loadEnvFile({ path: file, env });

    expect(result.found).toBe(true);
    expect(env.APP_MODE).toBe('demo');
    expect(env.LOG_LEVEL).toBe('debug');
    expect(result.applied.sort()).toEqual(['APP_MODE', 'LOG_LEVEL']);
  });

  it('never overrides a variable already set in the real environment', () => {
    const file = path.join(dir, '.env');
    writeFileSync(file, 'APP_MODE=demo\nLOG_LEVEL=debug\n');
    const env: Record<string, string | undefined> = { APP_MODE: 'live', LOG_LEVEL: '' };

    const result = loadEnvFile({ path: file, env });

    expect(env.APP_MODE).toBe('live');
    // An explicitly set empty variable is still "set" and wins.
    expect(env.LOG_LEVEL).toBe('');
    expect(result.applied).toEqual([]);
  });

  it('tolerates a missing .env file', () => {
    const env: Record<string, string | undefined> = { KEEP: '1' };

    const result = loadEnvFile({ path: path.join(dir, 'does-not-exist.env'), env });

    expect(result.found).toBe(false);
    expect(result.applied).toEqual([]);
    expect(env).toEqual({ KEEP: '1' });
  });

  it('parses quoted JSON values verbatim', () => {
    const file = path.join(dir, '.env');
    writeFileSync(file, `CREDENTIALS_KEYRING='{"k1":"abc+/="}'\n`);
    const env: Record<string, string | undefined> = {};

    loadEnvFile({ path: file, env });

    expect(JSON.parse(env.CREDENTIALS_KEYRING ?? '')).toEqual({ k1: 'abc+/=' });
  });
});

describe('runSetup (npm run setup)', () => {
  const examplePath = path.join(repoRoot, '.env.example');

  it('writes every .env.example key and fills generated demo secrets', () => {
    const envPath = path.join(dir, '.env');

    const result = runSetup({ examplePath, envPath });

    const exampleKeys = Object.keys(parse(readFileSync(examplePath)));
    const written = parse(readFileSync(envPath));
    expect(exampleKeys.length).toBeGreaterThan(10);
    for (const key of exampleKeys) {
      expect(written, `missing ${key}`).toHaveProperty(key);
    }
    expect(result.added.sort()).toEqual([...exampleKeys].sort());

    for (const key of GENERATED_SECRET_KEYS) {
      expect(written[key], `${key} should be generated`).toBeTruthy();
    }
    expect(Buffer.from(written.SESSION_SECRET ?? '', 'base64url').length).toBe(32);
    const ring = JSON.parse(written.CREDENTIALS_KEYRING ?? '{}') as Record<string, string>;
    const kid = written.CREDENTIALS_ACTIVE_KID ?? '';
    expect(kid).not.toBe('');
    expect(Buffer.from(ring[kid] ?? '', 'base64').length).toBe(32);
  });

  it('generates different secrets on different machines (runs)', () => {
    const a = path.join(dir, 'a', '.env');
    const b = path.join(dir, 'b', '.env');
    mkdirSync(path.dirname(a));
    mkdirSync(path.dirname(b));
    runSetup({ examplePath, envPath: a });
    runSetup({ examplePath, envPath: b });

    expect(parse(readFileSync(a)).SESSION_SECRET).not.toBe(parse(readFileSync(b)).SESSION_SECRET);
  });

  it('never overwrites existing keys and only appends missing ones', () => {
    const envPath = path.join(dir, '.env');
    writeFileSync(envPath, '# mine\nSESSION_SECRET=keep-me-please-this-is-my-own-secret\nAPP_MODE=live\n');

    const result = runSetup({ examplePath, envPath });
    const text = readFileSync(envPath, 'utf8');
    const written = parse(text);

    expect(text.startsWith('# mine\nSESSION_SECRET=keep-me-please-this-is-my-own-secret\nAPP_MODE=live\n')).toBe(true);
    expect(written.SESSION_SECRET).toBe('keep-me-please-this-is-my-own-secret');
    expect(written.APP_MODE).toBe('live');
    expect(result.added).not.toContain('SESSION_SECRET');
    expect(result.added).not.toContain('APP_MODE');
    expect(result.kept).toEqual(expect.arrayContaining(['SESSION_SECRET', 'APP_MODE']));
  });

  it('is idempotent: a second run adds nothing and changes no bytes', () => {
    const envPath = path.join(dir, '.env');
    runSetup({ examplePath, envPath });
    const first = readFileSync(envPath, 'utf8');

    const second = runSetup({ examplePath, envPath });

    expect(second.added).toEqual([]);
    expect(readFileSync(envPath, 'utf8')).toBe(first);
  });

  it('round-trips through loadEnvFile', () => {
    const envPath = path.join(dir, '.env');
    runSetup({ examplePath, envPath });
    const env: Record<string, string | undefined> = {};

    loadEnvFile({ path: envPath, env });

    expect(env.APP_MODE).toBe('demo');
    expect(existsSync(envPath)).toBe(true);
    expect(JSON.parse(env.CREDENTIALS_KEYRING ?? '')).toBeTypeOf('object');
  });
});
