/**
 * `leads.placesExpire` (ADR-118 (d), slice F1, P1): the workspace sweep that ends the 30-day life of
 * Places-sourced fields on imported leads whose contact was not confirmed first-party. Payload v1
 * `{}`, a workspace job queued for the end of the day bucket of a lead's `placesContentExpiresAt`
 * (by the finder import, then by itself for the next expiry). Everything happens in its fenced
 * settle (services/lead-finder/places-expire.ts).
 */
import { z } from 'zod';
import { getConfig } from '@/lib/config';
import { PLACES_EXPIRE_JOB } from '@/server/services/lead-finder/jobs';
import { expirePlacesDetails } from '@/server/services/lead-finder/places-expire';
import type { JobDefinition } from '../types';
import { jobCtx, parseWorkspacePayload } from './lead-job-support';

export { PLACES_EXPIRE_JOB };

const payloadSchema = z.object({}).strict();

export function createLeadsPlacesExpireJob(options: { mode?: () => 'demo' | 'live' } = {}): JobDefinition {
  const mode = options.mode ?? (() => getConfig().mode);
  return {
    type: PLACES_EXPIRE_JOB,
    kind: 'default',
    payloadVersions: [1],
    async handler(job) {
      const parsed = parseWorkspacePayload(job, payloadSchema);
      if (!parsed.ok) return parsed.result;
      const { workspaceId } = parsed;
      const ctx = { ...jobCtx(job, workspaceId, mode()), workspaceId };
      return { outcome: 'succeeded', finalTx: async (tx) => void (await expirePlacesDetails(tx, ctx, { jobId: job.job.id })) };
    },
  };
}

export const leadsPlacesExpireJob = createLeadsPlacesExpireJob();
