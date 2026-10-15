/**
 * `npm run pipeline:resume` (T23): resumes pipeline executions that halted visibly at a stage whose
 * handler did not exist yet (PipelineStageRun PENDING, STAGE_HANDLER_MISSING; before T23 every
 * execution stopped at APPROVAL this way). For each such run whose stage the production stage
 * registry now handles, it enqueues one `pipeline.advance` job under a resume key bound to the run;
 * the worker then runs the stage and the rest of the pinned pipeline. Running it again adds nothing.
 * Options: `--workspace <id>` limits it to one workspace.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { systemClock } from '../src/lib/clock';
import { ConfigError, getConfig } from '../src/lib/config';
import { ensureEnvLoaded } from '../src/lib/env-load';
import { redactText } from '../src/lib/redact';
import { createPrismaClient } from '../src/server/db/client';
import { resumeHaltedStages } from '../src/server/services/pipeline/config';
import { buildStageRegistry } from '../src/server/services/pipeline/stages';

function workspaceArg(argv: readonly string[]): string | null {
  const i = argv.indexOf('--workspace');
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
}

async function main(): Promise<number> {
  ensureEnvLoaded();
  let config;
  try {
    config = getConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
  const db = createPrismaClient({ url: config.paths.databaseUrl });
  try {
    const result = await resumeHaltedStages(db, systemClock, {
      stages: buildStageRegistry().stages(),
      workspaceId: workspaceArg(process.argv.slice(2)),
      correlationId: 'pipeline-resume',
    });
    console.log(result.resumed === 0 ? 'No halted pipeline stages to resume.' : `Queued ${result.resumed} pipeline.advance job(s); the worker resumes them.`);
    return 0;
  } catch (error) {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`pipeline:resume failed: ${redactText(text)}`);
    return 1;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
