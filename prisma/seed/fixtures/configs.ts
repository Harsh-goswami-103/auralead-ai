/**
 * Version 1 of the per-workspace scoring and pipeline configurations.
 *
 * Scoring v1 (P9): heuristic weights that sum to 100 over the inputs the score can see. An
 * unknown input contributes 0 and is listed as unknown (PRD: "heuristic, not intent or
 * consent"). T12 owns the Zod schema and the scorer; it may extend this shape through a new
 * config version, never by editing a seeded version in place.
 *
 * Pipeline v1 (E9, ADR-43): the five fixed stage kinds in DAG order, human approval.
 */

export const SCORING_V1 = {
  schemaVersion: 1,
  weights: {
    phonePresent: 15,
    emailPresent: 10,
    websiteStatus: 20,
    rating: 20,
    reviewCount: 15,
    categoryMatch: 15,
    sourceIntent: 5,
  },
  notes: 'Heuristic opportunity score. Not a measure of buying intent or consent.',
} as const;

export const PIPELINE_V1 = {
  schemaVersion: 1,
  stages: [
    { id: 'ingestion', kind: 'INGESTION', label: 'Ingestion' },
    { id: 'score', kind: 'SCORE', label: 'Score' },
    { id: 'draft', kind: 'DRAFT', label: 'Draft' },
    { id: 'approval', kind: 'APPROVAL', label: 'Approval' },
    { id: 'delivery', kind: 'DELIVERY', label: 'Delivery' },
  ],
  edges: [
    { from: 'ingestion', to: 'score' },
    { from: 'score', to: 'draft' },
    { from: 'draft', to: 'approval' },
    { from: 'approval', to: 'delivery' },
  ],
} as const;
