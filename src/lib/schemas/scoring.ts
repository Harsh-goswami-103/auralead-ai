/**
 * Scoring configuration schema (R14, P9, T12). One schema set shared by the scorer
 * (`server/services/scoring`), the scoring config tab (T26) and its route.
 *
 * A ScoringConfigVersion's `weights` JSON is this object. Weights are whole points over the seven
 * inputs the score can see and must sum to 100, so a lead with every input known and favourable
 * scores 100. Changing the shape means a new `schemaVersion`; stored versions are never edited.
 */
import { z } from 'zod';
import { ValidationError } from '@/lib/errors';

export const SCORE_INPUTS = ['phonePresent', 'emailPresent', 'websiteStatus', 'rating', 'reviewCount', 'categoryMatch', 'sourceIntent'] as const;
export type ScoreInputName = (typeof SCORE_INPUTS)[number];

/** Fixed caption shown with every score (06-design F17). */
export const SCORE_CAPTION = 'Heuristic fit score. Not purchase intent or consent.';

/** Reviews at or above this count earn the full review weight unless the config sets its own. */
export const DEFAULT_REVIEW_COUNT_TARGET = 100;

const weight = z.number().int().min(0).max(100);

export const scoringWeightsSchema = z.strictObject({
  phonePresent: weight,
  emailPresent: weight,
  websiteStatus: weight,
  rating: weight,
  reviewCount: weight,
  categoryMatch: weight,
  sourceIntent: weight,
});

export const scoringConfigSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    weights: scoringWeightsSchema,
    notes: z.string().max(500).optional(),
    /** Categories this workspace wants; matched case-insensitively as substrings either way. */
    targetCategories: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
    /** PRESENT (default): a reachable website earns the weight. ABSENT: a verified-absent one does. */
    websitePreference: z.enum(['PRESENT', 'ABSENT']).optional(),
    reviewCountTarget: z.number().int().min(1).max(100_000).optional(),
  })
  .superRefine((config, issue) => {
    const sum = SCORE_INPUTS.reduce((s, k) => s + config.weights[k], 0);
    if (sum !== 100) issue.addIssue({ code: 'custom', path: ['weights'], message: `weights must sum to 100 (got ${sum})` });
  });

export type ScoringConfig = z.infer<typeof scoringConfigSchema>;

/** Parses stored weights JSON; throws ValidationError SCORING_CONFIG_INVALID when it does not fit. */
export function parseScoringConfig(value: unknown): ScoringConfig {
  const parsed = scoringConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError({
      code: 'SCORING_CONFIG_INVALID',
      message: 'scoring config does not match the schema',
      userMessage: 'The scoring configuration is not valid.',
      safeDetails: { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    });
  }
  return parsed.data;
}
