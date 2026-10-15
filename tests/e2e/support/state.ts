/**
 * The harness state file: which app and worker processes are running and which temp dirs they
 * use. Teardown kills every recorded process tree and removes the dirs; global setup does the
 * same first, so a crashed earlier run never leaves orphans holding ports or DB files.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killPidTree } from '../../support/spawn';

// Outside test-results/ (Playwright cleans its output dir) and outside the OneDrive repo.
export const HARNESS_STATE_FILE = path.join(os.tmpdir(), 'auralead-e2e-harness.json');

type State = { apps: Array<{ pids: number[]; dataDir: string }> };

export async function stopRecorded(): Promise<void> {
  if (!existsSync(HARNESS_STATE_FILE)) return;
  const state = JSON.parse(readFileSync(HARNESS_STATE_FILE, 'utf8')) as State;
  for (const app of state.apps) {
    for (const pid of app.pids) await killPidTree(pid);
    rmSync(app.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
  rmSync(HARNESS_STATE_FILE, { force: true });
}
