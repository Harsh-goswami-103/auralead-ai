/**
 * Request bodies of the pipeline editor routes (T28), shared by the routes and the editor. The
 * graph is passed as data and validated by the server's PipelineConfigVersion validator (T23,
 * P11): only the five fixed stage kinds, no cycles, approval mandatory, delivery only through
 * approval. The shape check here is deliberately loose so that every rule answers with a named
 * issue (422 PIPELINE_INVALID) instead of a bare 400.
 */
import { z } from 'zod';

const workspaceSlug = z.string().trim().min(1).max(100).optional();

/** POST /api/app/pipeline/validate: a dry run that writes nothing. */
export const PipelineDraftBody = z.object({
  workspaceSlug,
  graph: z.unknown(),
  approvalMode: z.string().trim().min(1).max(32),
});
export type PipelineDraftBody = z.infer<typeof PipelineDraftBody>;

/** POST /api/app/pipeline/versions: activates the graph as version N+1 (CAS on the version the editor saw). */
export const PipelineSaveBody = PipelineDraftBody.extend({
  expectedVersion: z.number().int().min(0).max(1_000_000),
});
export type PipelineSaveBody = z.infer<typeof PipelineSaveBody>;
