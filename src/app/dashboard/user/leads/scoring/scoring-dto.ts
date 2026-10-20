/**
 * The scoring overview as the client components take it (ISO dates), shared by the client panel's
 * read-only tab and the operator console's editor (T26).
 */
import type { ScoringVersionDto } from '@/components/leads/ScoringConfigView';
import type { ScoringOverview, ScoringVersionView } from '@/server/services/scoring/manage';

function dto(v: ScoringVersionView): ScoringVersionDto {
  return { id: v.id, version: v.version, active: v.active, createdAt: v.createdAt.toISOString(), createdByName: v.createdByName, config: v.config };
}

export function scoringVersionDtos(overview: ScoringOverview): { active: ScoringVersionDto | null; history: ScoringVersionDto[] } {
  return { active: overview.active ? dto(overview.active) : null, history: overview.history.map(dto) };
}
