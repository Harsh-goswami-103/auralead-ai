/**
 * A real worker process for the T19 restart and lease tests. It boots through the production
 * `worker/boot.ts` (env loader, config, client factory, migration check, DbOffsetClock in DEMO test
 * control, heartbeat, reaper, claim loop) with the production dispatch handlers and their default
 * dependencies: config from the environment and the DEMO transports, which record every would-be
 * send in `<STORAGE_DIR>/demo-outbox/*.jsonl` (the cross-process call count).
 *
 * stdout: `READY` once booted, `EVENT <json>` per runtime event. stdin `STOP` stops gracefully.
 */
import { createInterface } from 'node:readline';
import { startWorkerProcess } from '../../../../worker/boot';
import { createDispatchEmailJob } from '@/server/jobs/handlers/dispatch-email';
import { createDispatchWhatsAppJob } from '@/server/jobs/handlers/dispatch-whatsapp';
import { buildJobRegistry } from '@/server/jobs/registry';

const tuning = JSON.parse(process.env.WORKER_TUNING ?? '{}') as Record<string, unknown>;

const proc = await startWorkerProcess({
  registry: buildJobRegistry([createDispatchWhatsAppJob(), createDispatchEmailJob()]),
  tuning,
  onEvent: (event) => console.log(`EVENT ${JSON.stringify(event)}`),
});

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === 'STOP') void proc.shutdown('stdin STOP');
});

console.log('READY');
await proc.done;
process.exit(0);
