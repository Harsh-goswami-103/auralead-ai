/**
 * Playwright global teardown (E11): stops every app and worker the global setup started (process
 * tree kill: `taskkill /T /F`, then SIGKILL) and removes their temp data dirs.
 */
import { startedApps } from './global-setup';
import { stopRecorded } from './state';

export default async function globalTeardown(): Promise<void> {
  for (const app of startedApps()) await app.stop();
  await stopRecorded();
}
