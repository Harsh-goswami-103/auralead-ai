/**
 * Plain data the Leads area hands from server pages to its client components (T26): the DTOs of
 * the shared leads schema module (dates as ISO strings, links resolved on the server), plus the
 * small helpers the components share. No server imports.
 */
import type { CappedCountDto, LeadRowDto } from '@/lib/schemas/leads';

export type { BoardColumnDto, CappedCountDto, LeadRowDto } from '@/lib/schemas/leads';

/** What the stage control needs about a lead. */
export type StageLead = Pick<LeadRowDto, 'id' | 'displayName' | 'salesStage' | 'stageVersion'>;

/** "1,000+" for a capped count, "12" otherwise. */
export function cappedCountText(total: CappedCountDto): string {
  return `${total.count.toLocaleString('en-IN')}${total.capped ? '+' : ''}`;
}
