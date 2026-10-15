/**
 * `pipeline.advance` (E9, ADR-43): runs one stage of a lead's pinned pipeline through the executor
 * in `services/pipeline/executor.ts`. Ingestion enqueues the first one; each settled stage enqueues
 * the next in the same fenced transaction.
 *
 * `createPipelineAdvanceJob` takes the stage registry and the mode source so tests can run the
 * real executor with stub stages; production uses the registered stage handlers and the boot
 * config's mode.
 */
import { getConfig } from '@/lib/config';
import { advancePipeline, PIPELINE_ADVANCE_JOB, PIPELINE_ADVANCE_PAYLOAD_VERSION } from '@/server/services/pipeline/executor';
import { buildStageRegistry, type StageRegistry } from '@/server/services/pipeline/stages';
import type { JobDefinition } from '../types';

export type PipelineAdvanceOptions = {
  stages?: StageRegistry;
  mode?: () => 'demo' | 'live';
};

export function createPipelineAdvanceJob(options: PipelineAdvanceOptions = {}): JobDefinition {
  let stages = options.stages;
  const mode = options.mode ?? (() => getConfig().mode);
  return {
    type: PIPELINE_ADVANCE_JOB,
    kind: 'default',
    payloadVersions: [PIPELINE_ADVANCE_PAYLOAD_VERSION],
    handler(ctx) {
      stages ??= buildStageRegistry();
      return advancePipeline(ctx, { stages, mode: mode() });
    },
  };
}

export const pipelineAdvanceJob = createPipelineAdvanceJob();
