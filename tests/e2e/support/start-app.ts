/**
 * Built-app E2E harness (E11, T09; reused by later E2E tasks and T38 `npm run verify`).
 *
 * buildApp(mode): `next build` with NEXT_PUBLIC_APP_MODE inlined for that mode (DEMO into .next,
 * LIVE into .next-live, ADR-50), plus the tsup worker bundle `dist/worker.js` once.
 *
 * startApp(opts): a temp data dir with a `.env` written by the real `npm run setup` code
 * (runSetup), free ports (get-port), `prisma migrate deploy`, the deterministic DEMO seed, then
 * `next start` and (optionally) `node dist/worker.js`, all with the repo as cwd and every app
 * variable passed explicitly (real env wins over any developer `.env`, E12). It waits for
 * GET /api/health = 200 and, with a worker, for a WorkerHeartbeat row from that worker's pid
 * written after it started. stop() kills each process tree (`taskkill /T /F`, then SIGKILL) and
 * removes the temp dir.
 *
 * Children are spawned with process.execPath (never npm.cmd). Nothing here imports Prisma: the
 * heartbeat is read through Node's built-in node:sqlite.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parse } from 'dotenv';
import getPort from 'get-port';
import { runSetup } from '../../../scripts/setup';
import { killPidTree, REPO_ROOT } from '../../support/spawn';

export type AppMode = 'demo' | 'live';

export const DIST_DIRS: Record<AppMode, string> = { demo: '.next', live: '.next-live' };
export const WORKER_BUNDLE = path.join(REPO_ROOT, 'dist', 'worker.js');

const NEXT_BIN = path.join(REPO_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
const TSUP_BIN = path.join(REPO_ROOT, 'node_modules', 'tsup', 'dist', 'cli-default.js');
const PRISMA_CLI = path.join(REPO_ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const TSX_LOADER = pathToFileURL(path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const EXAMPLE_ENV = path.join(REPO_ROOT, '.env.example');

type Env = Record<string, string>;

/** process.env without any app variable (every key in .env.example and AURALEAD_*). */
export function baseEnv(): Env {
  const appKeys = new Set(Object.keys(parse(readFileSync(EXAMPLE_ENV, 'utf8'))));
  const env: Env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || appKeys.has(k) || k.startsWith('AURALEAD_') || k === 'NODE_ENV' || k.startsWith('E2E_')) continue;
    env[k] = v;
  }
  env.PRISMA_HIDE_UPDATE_MESSAGE = '1';
  env.CHECKPOINT_DISABLE = '1';
  env.NEXT_TELEMETRY_DISABLED = '1';
  return env;
}

type RunResult = { code: number | null; output: string };

function runNode(args: string[], env: Env, label: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout!.on('data', (c: Buffer) => (output += c.toString('utf8')));
    child.stderr!.on('data', (c: Buffer) => (output += c.toString('utf8')));
    const timer = setTimeout(() => {
      if (child.pid) void killPidTree(child.pid);
      reject(new Error(`${label} timed out after ${timeoutMs} ms\n${output}`));
    }, timeoutMs);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ code, output });
      else reject(new Error(`${label} exited ${code}\n${output}`));
    });
  });
}

/** Env for a build: the setup-generated values of a scratch `.env`, with the mode inlined. */
function buildEnv(mode: AppMode): Env {
  const dir = mkdtempSync(path.join(os.tmpdir(), `auralead-e2e-build-${mode}-`));
  try {
    runSetup({ examplePath: EXAMPLE_ENV, envPath: path.join(dir, '.env') });
    const generated = parse(readFileSync(path.join(dir, '.env'), 'utf8'));
    return { ...baseEnv(), ...generated, APP_MODE: mode, NEXT_PUBLIC_APP_MODE: mode, AURALEAD_TEST_CONTROL: '0', AURALEAD_NEXT_DIST_DIR: DIST_DIRS[mode], AURALEAD_DATA_DIR: path.join(dir, 'data') };
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/** `next build` for one mode (DEMO bundles the role switcher, LIVE must not contain it). */
export async function buildApp(mode: AppMode): Promise<void> {
  await runNode([NEXT_BIN, 'build'], buildEnv(mode), `next build (${mode})`, 600_000);
}

/** The worker bundle, with the same tsup arguments as `npm run build`. */
export async function buildWorker(): Promise<void> {
  await runNode(
    [TSUP_BIN, '--entry.worker', 'worker/index.ts', '--format', 'esm', '--platform', 'node', '--target', 'node22', '--out-dir', 'dist', '--clean'],
    baseEnv(),
    'tsup worker',
    300_000,
  );
}

export function isBuilt(mode: AppMode): boolean {
  return existsSync(path.join(REPO_ROOT, DIST_DIRS[mode], 'BUILD_ID'));
}

export type StartOptions = { mode: AppMode; worker?: boolean; seed?: boolean };

export type StartedApp = {
  mode: AppMode;
  baseURL: string;
  port: number;
  dataDir: string;
  dbFile: string;
  env: Env;
  pids: number[];
  logs: () => string;
  stop: () => Promise<void>;
};

type Proc = { child: ChildProcess; label: string; log: string; exited: boolean };

function startProc(args: string[], env: Env, label: string): Proc {
  const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const proc: Proc = { child, label, log: '', exited: false };
  const keep = (c: Buffer) => {
    proc.log = (proc.log + c.toString('utf8')).slice(-20_000);
  };
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  child.on('exit', () => {
    proc.exited = true;
  });
  return proc;
}

async function waitFor(what: string, probe: () => Promise<boolean>, procs: Proc[], timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const dead = procs.find((p) => p.exited);
    if (dead) throw new Error(`${dead.label} exited while waiting for ${what}:\n${dead.log}`);
    if (await probe().catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n${procs.map((p) => `--- ${p.label}\n${p.log}`).join('\n')}`);
}

/** True once the worker with this pid has written a heartbeat at or after `since`. */
export function hasFreshHeartbeat(dbFile: string, pid: number, since: Date): boolean {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const row = db.prepare('SELECT "lastBeatAt" FROM "WorkerHeartbeat" WHERE "pid" = ? ORDER BY "lastBeatAt" DESC LIMIT 1').get(pid) as { lastBeatAt?: string } | undefined;
    return row?.lastBeatAt !== undefined && new Date(row.lastBeatAt).getTime() >= since.getTime() - 1_000;
  } finally {
    db.close();
  }
}

export async function startApp(opts: StartOptions): Promise<StartedApp> {
  const { mode } = opts;
  if (!isBuilt(mode)) throw new Error(`no ${mode} build in ${DIST_DIRS[mode]}: run the harness without E2E_SKIP_BUILD`);
  if (opts.worker && !existsSync(WORKER_BUNDLE)) throw new Error('dist/worker.js is missing: run the harness without E2E_SKIP_BUILD');

  const dataDir = mkdtempSync(path.join(os.tmpdir(), `auralead-e2e-${mode}-`));
  runSetup({ examplePath: EXAMPLE_ENV, envPath: path.join(dataDir, '.env') });
  const generated = parse(readFileSync(path.join(dataDir, '.env'), 'utf8'));
  const port = await getPort();
  const baseURL = `http://localhost:${port}`;
  const dbFile = path.join(dataDir, 'data', mode, 'app.db');
  const env: Env = {
    ...baseEnv(),
    ...generated,
    APP_MODE: mode,
    NEXT_PUBLIC_APP_MODE: mode,
    APP_ORIGIN: baseURL,
    AURALEAD_DATA_DIR: path.join(dataDir, 'data'),
    DATABASE_URL: '',
    AURALEAD_TEST_CONTROL: mode === 'demo' ? '1' : '0',
    AURALEAD_NEXT_DIST_DIR: DIST_DIRS[mode],
    LOG_LEVEL: 'warn',
  };

  const procs: Proc[] = [];
  const stop = async () => {
    for (const p of procs) if (p.child.pid) await killPidTree(p.child.pid);
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  };

  try {
    await runNode([PRISMA_CLI, 'migrate', 'deploy'], env, `prisma migrate deploy (${mode})`, 120_000);
    if (opts.seed) await runNode(['--import', TSX_LOADER, path.join(REPO_ROOT, 'prisma', 'seed', 'index.ts')], env, 'seed', 120_000);

    const web = startProc([NEXT_BIN, 'start', '-p', String(port)], env, `next start (${mode})`);
    procs.push(web);
    let workerStartedAt: Date | null = null;
    if (opts.worker) {
      workerStartedAt = new Date();
      procs.push(startProc([WORKER_BUNDLE], env, 'worker'));
    }

    await waitFor(`${baseURL}/api/health`, async () => (await fetch(`${baseURL}/api/health`)).status === 200, procs, 120_000);
    if (opts.worker && workerStartedAt) {
      const workerPid = procs[1]!.child.pid!;
      await waitFor('a fresh worker heartbeat', async () => hasFreshHeartbeat(dbFile, workerPid, workerStartedAt), procs, 60_000);
    }
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    mode,
    baseURL,
    port,
    dataDir,
    dbFile,
    env,
    pids: procs.map((p) => p.child.pid!).filter((pid) => pid !== undefined),
    logs: () => procs.map((p) => `--- ${p.label}\n${p.log}`).join('\n'),
    stop,
  };
}
