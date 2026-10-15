/**
 * A real worker process for the E1 restart test. It boots through the production
 * `worker/boot.ts` (env loader, config, client factory, migration check, DbOffsetClock in DEMO +
 * test control) and registers the production `ingest.process` and `webhook.purge` definitions,
 * which read the key ring and the contact-key pepper from the process config, exactly as the
 * shipped worker does. `pipeline.advance` runs with the INGESTION stage only, so later stages
 * halt visibly (STAGE_HANDLER_MISSING) and the test observes ingestion alone.
 *
 * stdout: `READY` once booted, `EVENT <json>` per runtime event. stdin: `STOP` stops gracefully.
 */
import { createInterface } from 'node:readline';
import { startWorkerProcess } from '../../../../worker/boot';
import { ingestProcessJob } from '@/server/jobs/handlers/ingest-process';
import { webhookPurgeJob } from '@/server/jobs/handlers/webhook-purge';
import { createPipelineAdvanceJob } from '@/server/jobs/handlers/pipeline-advance';
import { buildJobRegistry } from '@/server/jobs/registry';
import { StageRegistry } from '@/server/services/pipeline/stages';
import { ingestionStage } from '@/server/services/pipeline/stages/ingestion';

const tuning = JSON.parse(process.env.WORKER_TUNING ?? '{}') as Record<string, unknown>;

const proc = await startWorkerProcess({
  registry: buildJobRegistry([ingestProcessJob, webhookPurgeJob, createPipelineAdvanceJob({ stages: new StageRegistry().register(ingestionStage) })]),
  tuning,
  onEvent: (event) => console.log(`EVENT ${JSON.stringify(event)}`),
});

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === 'STOP') void proc.shutdown('stdin STOP');
});

console.log('READY');
await proc.done;
process.exit(0);
