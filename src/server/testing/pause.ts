/**
 * Named pause points for race tests (plan §3, §4.4 P2/P3, E5). `pausePoint(name)` is a no-op
 * unless NODE_ENV=test. In a test process it either:
 * - awaits an in-process handler installed with `setPauseHandler(name, fn)`, or
 * - when `AURALEAD_PAUSE_DIR` is set and `AURALEAD_PAUSE_AT` (comma list) names the point, writes
 *   `<dir>/<name>.reached.json` and waits until `<dir>/<name>.release` exists. This lets a test
 *   freeze a worker process at an exact step (for example right after its claim), change the
 *   world, and release it. Each file-based point pauses once per process.
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export type PauseInfo = Readonly<Record<string, string | number | null>>;
export type PauseHandler = (info: PauseInfo) => Promise<void>;

const NAME_RE = /^[a-z][a-z0-9.-]{0,63}$/;
const handlers = new Map<string, PauseHandler>();
const consumed = new Set<string>();

function enabled(): boolean {
  return process.env.NODE_ENV === 'test';
}

function assertName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`invalid pause point name: ${name}`);
}

export function setPauseHandler(name: string, handler: PauseHandler | null): void {
  assertName(name);
  if (!enabled()) throw new Error('pause handlers are only available when NODE_ENV=test');
  if (handler) handlers.set(name, handler);
  else handlers.delete(name);
}

function armedFromEnv(name: string): string | null {
  const dir = process.env.AURALEAD_PAUSE_DIR;
  const points = (process.env.AURALEAD_PAUSE_AT ?? '').split(',').map((p) => p.trim());
  if (!dir || !points.includes(name) || consumed.has(name)) return null;
  return dir;
}

export async function pausePoint(name: string, info: PauseInfo = {}): Promise<void> {
  if (!enabled()) return;
  assertName(name);
  const handler = handlers.get(name);
  if (handler) {
    await handler(info);
    return;
  }
  const dir = armedFromEnv(name);
  if (dir === null) return;
  consumed.add(name);
  const release = path.join(dir, `${name}.release`);
  await writeFile(path.join(dir, `${name}.reached.json`), JSON.stringify({ pid: process.pid, ...info }));
  while (!existsSync(release)) await sleep(20);
}
