/**
 * Words for the scoring configuration (T26, P9): one label and one explanation per score input,
 * shared by the read-only view and the editor, so the owner and the operator read the same thing.
 */
import type { ScoreInputName } from '@/lib/schemas/scoring';

export const SCORE_INPUT_LABELS: Readonly<Record<ScoreInputName, { label: string; help: string }>> = {
  phonePresent: { label: 'Phone on record', help: 'Full points when the lead has a valid phone number.' },
  emailPresent: { label: 'Email on record', help: 'Full points when the lead has a valid email address.' },
  websiteStatus: { label: 'Website', help: 'Known only after a check: reachable, or verified absent by a person. Unchecked websites score 0 as unknown.' },
  rating: { label: 'Rating', help: 'Points in proportion to the star rating out of 5. Unknown when the source has none.' },
  reviewCount: { label: 'Number of reviews', help: 'Points in proportion to the review count, up to the review target below.' },
  categoryMatch: { label: 'Category matches a target', help: 'Full points when the category contains one of the target categories. Unknown without targets.' },
  sourceIntent: { label: 'Came in through a form or message', help: 'Full points for form and inbound leads; 0 for Maps listings; unknown for leads added by hand.' },
};

export const WEBSITE_PREFERENCE_LABELS = {
  PRESENT: 'A reachable website earns the points',
  ABSENT: 'A verified missing website earns the points (for businesses that sell websites)',
} as const;
