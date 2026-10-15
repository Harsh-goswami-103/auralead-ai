/**
 * Worker entry: `npm run worker` (tsx) and `node dist/worker.js` (tsup bundle). No HTTP listener.
 * Exits 1 on boot failure (invalid config, pending migrations), 0 after a graceful stop.
 */
import { redactText } from '@/lib/redact';
import { buildJobRegistry } from '@/server/jobs/registry';
import { startWorkerProcess } from './boot';

try {
  const proc = await startWorkerProcess({ registry: buildJobRegistry() });
  await proc.done;
  process.exit(0);
} catch (error) {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  process.stderr.write(`worker failed to start: ${redactText(text)}\n`);
  process.exit(1);
}
