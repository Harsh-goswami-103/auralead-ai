/**
 * A second, independent SQLite connection in its OWN PROCESS, for tests that need real write-lock
 * contention against the app's better-sqlite3 connection.
 *
 * It must be a separate process: POSIX advisory file locks belong to the process, so two SQLite
 * library copies (node:sqlite and better-sqlite3) inside one Node process never conflict on Linux
 * and macOS, while on Windows they do. A child process behaves the same on every OS. It speaks
 * JSON lines over stdio with `sqlite-holder-child.mjs` (busy_timeout 0: contention fails at once).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { REPO_ROOT } from './spawn';

export type LockHolder = {
  /** Runs SQL on the holder's connection; rejects with SQLite's message (for example "database is locked"). */
  exec(sql: string): Promise<void>;
  /** Rolls back an open transaction, if any (so a lock held by this connection is released). */
  release(): Promise<void>;
  close(): Promise<void>;
};

const CHILD = path.join(REPO_ROOT, 'tests', 'support', 'sqlite-holder-child.mjs');

export function openLockHolder(dbFile: string): Promise<LockHolder> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [CHILD, dbFile], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let exited = false;
  child.on('exit', () => {
    exited = true;
    for (const p of pending.values()) p.reject(new Error('lock holder exited'));
    pending.clear();
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line) as { id: number; ok: boolean; error?: string };
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve();
    else p.reject(new Error(msg.error ?? 'lock holder error'));
  });

  const send = (op: 'exec' | 'release' | 'close', sql?: string) =>
    new Promise<void>((resolve, reject) => {
      if (exited) return resolve();
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, op, sql })}\n`);
    });

  const holder: LockHolder = {
    exec: (sql) => send('exec', sql),
    release: () => send('release'),
    close: () => send('close').then(() => undefined, () => undefined),
  };
  // Resolve once the child accepted its first command, so a bad path fails here and not later.
  return holder.exec('SELECT 1').then(() => holder);
}
