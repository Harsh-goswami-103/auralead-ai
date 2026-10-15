/**
 * Pipeline stage-handler registry (E9, ADR-43). Append-only shared file: each task that ships a
 * stage adds one import and one entry to `STAGE_HANDLERS`
 *   T12: `import { scoreStage } from './score';`  then `scoreStage,`
 *   T14: `import { draftStage } from './draft';`  then `draftStage,`
 *   T23: APPROVAL and DELIVERY.
 * A stage kind with no registered handler halts the execution visibly at that stage
 * (PipelineStageRun PENDING, reasonCode STAGE_HANDLER_MISSING, audited); it is never skipped.
 */
import type { PipelineStage } from '@/generated/prisma/client';
import { ingestionStage } from './ingestion';
import { scoreStage } from './score';
import { draftStage } from './draft';
import type { StageHandler } from './types';

export class StageRegistry {
  readonly #handlers = new Map<PipelineStage, StageHandler>();

  register(handler: StageHandler): this {
    if (this.#handlers.has(handler.stage)) throw new Error(`pipeline stage already registered: ${handler.stage}`);
    this.#handlers.set(handler.stage, handler);
    return this;
  }

  get(stage: PipelineStage): StageHandler | undefined {
    return this.#handlers.get(stage);
  }

  stages(): PipelineStage[] {
    return [...this.#handlers.keys()];
  }
}

/** Production stage handlers. Append below; keep one entry per stage kind. */
export const STAGE_HANDLERS: readonly StageHandler[] = [
  ingestionStage,
  scoreStage,
  draftStage,
];

export function buildStageRegistry(handlers: readonly StageHandler[] = STAGE_HANDLERS): StageRegistry {
  const registry = new StageRegistry();
  for (const handler of handlers) registry.register(handler);
  return registry;
}

export type { StageHandler, StageOutcome, StageRunInput } from './types';
