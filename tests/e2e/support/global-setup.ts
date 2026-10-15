/**
 * Playwright global setup (E11): build once (DEMO and LIVE bundles plus the worker; skip with
 * E2E_SKIP_BUILD=1 to reuse existing builds), then start the DEMO app with its worker on a seeded
 * temp DB and a LIVE app on an empty temp DB. Exports their URLs to the test workers:
 *   E2E_BASE_URL (DEMO, also Playwright's baseURL), E2E_LIVE_BASE_URL, E2E_TEST_CONTROL_TOKEN.
 * The started processes are recorded in the harness state file (state.ts) so global-teardown (or a
 * later run, after a crash) can kill them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../../support/spawn';
import { buildApp, buildWorker, startApp, type StartedApp } from './start-app';
import { HARNESS_STATE_FILE, stopRecorded } from './state';

const HOLDER = Symbol.for('auralead.e2e.apps');
type Holder = { [HOLDER]?: StartedApp[] };

export default async function globalSetup(): Promise<void> {
  await stopRecorded();
  if (process.env.E2E_SKIP_BUILD !== '1') {
    await buildApp('live');
    await buildApp('demo');
    await buildWorker();
  }

  const apps: StartedApp[] = [];
  (globalThis as Holder)[HOLDER] = apps;
  const record = () => {
    mkdirSync(path.dirname(HARNESS_STATE_FILE), { recursive: true });
    writeFileSync(HARNESS_STATE_FILE, JSON.stringify({ apps: apps.map((a) => ({ mode: a.mode, baseURL: a.baseURL, pids: a.pids, dataDir: a.dataDir })) }, null, 2));
  };

  let demo: StartedApp;
  let live: StartedApp;
  try {
    demo = await startApp({ mode: 'demo', worker: true, seed: true });
    apps.push(demo);
    record();
    live = await startApp({ mode: 'live', worker: false, seed: false });
    apps.push(live);
    record();
  } catch (error) {
    for (const app of apps) await app.stop();
    await stopRecorded();
    throw error;
  }

  process.env.E2E_BASE_URL = demo.baseURL;
  process.env.E2E_LIVE_BASE_URL = live.baseURL;
  process.env.E2E_TEST_CONTROL_TOKEN = demo.env.TEST_CONTROL_TOKEN ?? '';
  process.env.E2E_REPO_ROOT = REPO_ROOT;
}

export function startedApps(): StartedApp[] {
  return (globalThis as Holder)[HOLDER] ?? [];
}
