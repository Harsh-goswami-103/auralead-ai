/**
 * A lead's sales stage as a status chip (icon + label in the stage's tone). Not a link, so the lead
 * name stays the first link of a lead row. Server-safe.
 */
import { salesStageEntry } from './lead-vocabulary';
import { ToneChip } from './ToneChip';

export function StageChip({ stage, className }: { stage: string; className?: string }) {
  const entry = salesStageEntry(stage);
  return <ToneChip tone={entry.tone} icon={entry.icon} label={entry.label} className={className} attrs={{ 'data-sales-stage': stage }} />;
}
