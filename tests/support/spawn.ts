/**
 * Child-process helpers for integration tests (plan §1: spawn `process.execPath`, never npm.cmd).
 *
 * `spawnTsx` runs a TypeScript entry with `node --import tsx` so children resolve `@/` paths the
 * same way the worker does in dev. `terminate` kills the whole process tree: on Windows
 * `taskkill /T /F /PID` first (a plain SIGKILL there only reaches the direct child and would
 * orphan grandchildren), then `child.kill('SIGKILL')` as the fallback; on POSIX SIGKILL.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export type ExitResult = { code: number | null; signal: NodeJS.Signals | null };

export type SpawnedNode = {
  child: ChildProcess;
  pid: number;
  /** Every stdout line seen so far. */
  lines: string[];
  /** Accumulated stderr text. */
  stderr: () => string;
  /** Resolves with the first stdout line (past or future) matching `predicate`. */
  waitForLine: (predicate: (line: string) => boolean, timeoutMs?: number) => Promise<string>;
  /** Resolves when the process exits; rejects after `timeoutMs`. */
  waitForExit: (timeoutMs?: number) => Promise<ExitResult>;
  send: (line: string) => void;
};

const live = new Set<SpawnedNode>();

export type SpawnTsxOptions = {
  env?: Record<string, string | undefined>;
  args?: string[];
  cwd?: string;
};

export function spawnTsx(scriptPath: string, options: SpawnTsxOptions = {}): SpawnedNode {
  const child = spawn(process.execPath, ['--import', 'tsx', scriptPath, ...(options.args ?? [])], {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // POSIX: its own process group, so `terminate` can kill the child together with its descendants.
    detached: process.platform !== 'win32',
  });
  if (child.pid === undefined) throw new Error(`failed to spawn ${scriptPath}`);

  const lines: string[] = [];
  const waiters: Array<{ predicate: (line: string) => boolean; resolve: (line: string) => void }> = [];
  let stderrText = '';
  let exitResult: ExitResult | null = null;
  const exitWaiters: Array<(r: ExitResult) => void> = [];

  createInterface({ input: child.stdout! }).on('line', (line) => {
    lines.push(line);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i]!;
      if (w.predicate(line)) {
        waiters.splice(i, 1);
        w.resolve(line);
      }
    }
  });
  child.stderr!.on('data', (chunk: Buffer) => {
    stderrText += chunk.toString('utf8');
  });

  const handle: SpawnedNode = {
    child,
    pid: child.pid,
    lines,
    stderr: () => stderrText,
    waitForLine(predicate, timeoutMs = 30_000) {
      const seen = lines.find(predicate);
      if (seen !== undefined) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`timed out waiting for a stdout line from pid ${handle.pid}; stderr: ${stderrText}`));
        }, timeoutMs);
        waiters.push({
          predicate,
          resolve: (line) => {
            clearTimeout(timer);
            resolve(line);
          },
        });
        if (exitResult) {
          clearTimeout(timer);
          reject(new Error(`pid ${handle.pid} exited (${JSON.stringify(exitResult)}) before the line; stderr: ${stderrText}`));
        }
      });
    },
    waitForExit(timeoutMs = 60_000) {
      if (exitResult) return Promise.resolve(exitResult);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`pid ${handle.pid} did not exit in ${timeoutMs} ms`)), timeoutMs);
        exitWaiters.push((r) => {
          clearTimeout(timer);
          resolve(r);
        });
      });
    },
    send(line) {
      child.stdin!.write(`${line}\n`);
    },
  };

  child.on('exit', (code, signal) => {
    exitResult = { code, signal };
    live.delete(handle);
    for (const resolve of exitWaiters.splice(0)) resolve(exitResult);
  });
  live.add(handle);
  return handle;
}

/** True while a process with this pid exists (signal 0 probes without killing). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function waitForPidExit(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isPidAlive(pid);
}

function taskkillTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => resolve());
  });
}

/** SIGKILL to the whole process group of a pid spawned `detached` (POSIX only); false if it is not a group leader. */
function killProcessGroup(pid: number): boolean {
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/** Kills a pid and its descendants (taskkill /T on Windows, the process group elsewhere), then waits for it to disappear. */
export async function killPidTree(pid: number, timeoutMs = 10_000): Promise<void> {
  if (!isPidAlive(pid)) return;
  if (process.platform === 'win32') await taskkillTree(pid);
  else killProcessGroup(pid);
  if (isPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  if (!(await waitForPidExit(pid, timeoutMs))) throw new Error(`pid ${pid} survived taskkill and SIGKILL`);
}

/** Kills a spawned child and its descendants; resolves once the child has exited. */
export async function terminate(handle: SpawnedNode, timeoutMs = 10_000): Promise<void> {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  if (process.platform === 'win32') await taskkillTree(handle.pid);
  else killProcessGroup(handle.pid);
  if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill('SIGKILL');
  await handle.waitForExit(timeoutMs);
  if (!(await waitForPidExit(handle.pid, timeoutMs))) throw new Error(`pid ${handle.pid} still alive after terminate`);
}

/** Teardown for afterAll: terminate every child this module spawned that is still running. */
export async function terminateAll(): Promise<void> {
  await Promise.all([...live].map((h) => terminate(h)));
}
