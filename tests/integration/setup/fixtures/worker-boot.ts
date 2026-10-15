/**
 * Boots the worker through the production `startWorkerProcess` (single env loader on
 * `<cwd>/.env`, config, client factory, pending-migration refusal against the repo's migrations,
 * heartbeat loop), waits for its first heartbeat row, prints one line `RESULT <json>`
 * { databaseUrl, workerId, heartbeatMode }, then stops gracefully.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { getConfig } from '@/lib/config';
import { buildJobRegistry } from '@/server/jobs/registry';
import { startWorkerProcess } from '../../../../worker/boot';

const repoRoot = process.env.AURALEAD_REPO_ROOT;
if (!repoRoot) throw new Error('AURALEAD_REPO_ROOT is required (the migrations live in the repo)');

const proc = await startWorkerProcess({ registry: buildJobRegistry(), cwd: repoRoot, installSignalHandlers: false });
let beat = null;
for (let i = 0; i < 100 && beat === null; i++) {
  beat = await proc.db.workerHeartbeat.findUnique({ where: { workerId: proc.worker.workerId } });
  if (beat === null) await sleep(100);
}
console.log(`RESULT ${JSON.stringify({ databaseUrl: getConfig().paths.databaseUrl, workerId: proc.worker.workerId, heartbeatMode: beat?.mode ?? null })}`);
await proc.shutdown('test done');
await proc.done;
