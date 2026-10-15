/**
 * POST /api/demo/simulate/[source] body (T11), shared by the route and the lead console buttons.
 * `workspaceSlug` selects one of the caller's own workspaces (membership or active assignment,
 * resolved server-side exactly like a `[ws]` segment); without it the session's workspace is used.
 * `batchId` makes a simulation repeatable (a replay of the same id is a duplicate delivery).
 */
import { z } from 'zod';

export const SIMULATION_SOURCES = ['sheets', 'meta', 'gmaps'] as const;
export type SimulationSource = (typeof SIMULATION_SOURCES)[number];

export const SIMULATION_SOURCE_LABELS: Readonly<Record<SimulationSource, string>> = {
  sheets: 'Google Sheets form row',
  meta: 'Meta Lead Ads lead',
  gmaps: 'Maps extension batch',
};

export const simulateBodySchema = z.object({
  workspaceSlug: z.string().trim().min(1).max(100).optional(),
  count: z.number().int().min(1).max(10).default(3),
  batchId: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,64}$/)
    .optional(),
});
export type SimulateBody = z.input<typeof simulateBodySchema>;
