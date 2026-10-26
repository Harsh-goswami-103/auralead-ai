/**
 * E12 / ADR-44 (T09): a fresh directory configured by `npm run setup` alone is enough. In a temp
 * dir holding only `.env.example`, run the real setup script, then (with no app variables in the
 * environment) migrate with the real Prisma config, boot the web runtime and serve /api/health,
 * boot the worker until it writes a heartbeat, and print `db:path`: all of them must resolve the
 * same SQLite file. Every child runs with the temp dir as its working directory, so the only
 * configuration is the `.env` that setup wrote. That `.env` is a LIVE install (ADR-116): LIVE
 * boots on the generated secrets, with no seed and no DEMO setting.
 *
 * The OS data-dir variable (LOCALAPPDATA, or XDG_DATA_HOME off Windows) is pointed into the temp
 * dir so the test never touches the developer's real %LOCALAPPDATA%\auralead. It is the
 * platform's own location variable, not an app setting.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'dotenv';
import { toSqliteFileUrl } from '@/lib/paths';
import { removeDir } from '../../support/db';
import { killPidTree, POSIX_DETACH, REPO_ROOT } from '../../support/spawn';

const TSX_LOADER = pathToFileURL(path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const PRISMA_CLI = path.join(REPO_ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const tmp = path.join(os.tmpdir(), `auralead-setup-${process.pid}-${randomUUID().slice(0, 8)}`);
const dataHome = path.join(tmp, 'os-data');
const children = new Set<ChildProcess>();

/** The process env with every app variable removed (only `.env` may configure the children). */
function cleanEnv(): Record<string, string> {
  const appKeys = new Set(Object.keys(parse(readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8'))));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || appKeys.has(k) || k.startsWith('AURALEAD_') || k === 'NODE_ENV' || k.startsWith('VITEST')) continue;
    env[k] = v;
  }
  if (process.platform === 'win32') env.LOCALAPPDATA = dataHome;
  else env.XDG_DATA_HOME = dataHome;
  env.TSX_TSCONFIG_PATH = path.join(REPO_ROOT, 'tsconfig.json');
  env.PRISMA_HIDE_UPDATE_MESSAGE = '1';
  env.CHECKPOINT_DISABLE = '1';
  return env;
}

type Run = { code: number | null; stdout: string; stderr: string };

function run(args: string[], extraEnv: Record<string, string> = {}, timeoutMs = 90_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: tmp, env: { ...cleanEnv(), ...extraEnv } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: POSIX_DETACH });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr!.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const timer = setTimeout(() => reject(new Error(`timed out: ${args.join(' ')}\n${stdout}\n${stderr}`)), timeoutMs);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
}

const tsx = (script: string, args: string[] = [], extraEnv: Record<string, string> = {}) =>
  run(['--import', TSX_LOADER, path.join(REPO_ROOT, script), ...args], extraEnv);

/** The fixture's result line (`RESULT <json>`); log lines are JSON too, so the prefix tells them apart. */
function result(text: string): Record<string, unknown> {
  const line = text.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
  if (!line) throw new Error(`no RESULT line in:\n${text}`);
  return JSON.parse(line.slice('RESULT '.length)) as Record<string, unknown>;
}

afterAll(async () => {
  for (const child of children) if (child.pid) await killPidTree(child.pid);
  await removeDir(tmp);
});

describe('setup-only configuration (E12)', () => {
  it('app, worker, prisma and db:path boot from the setup-generated .env and agree on the DB path', async () => {
    mkdirSync(tmp, { recursive: true });
    copyFileSync(path.join(REPO_ROOT, '.env.example'), path.join(tmp, '.env.example'));

    const setup = await tsx('scripts/setup.ts');
    expect(setup.code, setup.stderr).toBe(0);
    const env = parse(readFileSync(path.join(tmp, '.env'), 'utf8'));
    for (const key of ['SESSION_SECRET', 'SHARE_NONCE_KEY', 'SUPPRESSION_PEPPER', 'CREDENTIALS_KEYRING', 'TEST_CONTROL_TOKEN']) {
      expect(env[key], key).toBeTruthy();
    }
    expect(env.APP_MODE).toBe('live');
    expect(env.NEXT_PUBLIC_APP_MODE).toBe('live');

    const expectedFile = path.join(dataHome, 'auralead', 'live', 'app.db');
    const expectedUrl = toSqliteFileUrl(expectedFile);

    const dbPath = await tsx('scripts/db-path.ts', ['--url']);
    expect(dbPath.code, dbPath.stderr).toBe(0);
    expect(dbPath.stdout.trim().split(/\r?\n/)[0]).toBe(expectedUrl);

    const migrate = await run([PRISMA_CLI, 'migrate', 'deploy', '--config', path.join(REPO_ROOT, 'prisma.config.ts')]);
    expect(migrate.code, migrate.stdout + migrate.stderr).toBe(0);
    expect(existsSync(expectedFile)).toBe(true);

    const app = await tsx('tests/integration/setup/fixtures/app-boot.ts');
    expect(app.code, app.stderr).toBe(0);
    const appOut = result(app.stdout);
    expect(appOut).toMatchObject({ databaseUrl: expectedUrl, mode: 'live', healthStatus: 200, health: { status: 'ok', mode: 'live' } });

    const worker = await tsx('tests/integration/setup/fixtures/worker-boot.ts', [], { AURALEAD_REPO_ROOT: REPO_ROOT });
    expect(worker.code, worker.stderr).toBe(0);
    const workerOut = result(worker.stdout);
    expect(workerOut).toMatchObject({ databaseUrl: expectedUrl, heartbeatMode: 'LIVE' });
    expect(typeof workerOut.workerId).toBe('string');
  });
});
