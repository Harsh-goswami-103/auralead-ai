/**
 * Steps 3 and 4 of the lead import (ADR-120): the progress of a confirmed import (rows processed
 * out of the file's rows, from the import's own counts) and the result summary: what became new
 * leads, duplicates, merge reviews and rejected rows, WhatsApp opt-ins recorded, and the row-level
 * reasons grouped by code (row numbers only; cell values are never kept). Server-safe.
 */
import { CircleCheck, Copy, GitMerge, ShieldCheck, UserPlus, XCircle } from 'lucide-react';
import { StatTile } from '@/components/patterns/StatTile';
import { ToneChip } from '@/components/leads/ToneChip';
import { importRowCodeLabel, isConsentNoteCode, type ConsentDecision, type ImportRowNote, type LeadImportDto } from '@/lib/schemas/lead-import';
import { CONSENT_DECISION_LABELS, IMPORT_COUNT_LABELS, IMPORT_STATUS } from './import-vocabulary';

const ROWS_SHOWN = 40;

export function ImportProgress(props: { dto: LeadImportDto; exhausted: boolean }) {
  const { dto } = props;
  const status = IMPORT_STATUS[dto.effectiveStatus];
  const done = Math.min(dto.counts.processed, dto.rowCount);
  const percent = dto.rowCount === 0 ? 0 : Math.round((done / dto.rowCount) * 100);
  return (
    <div className="flex flex-col gap-3" data-import-status={dto.effectiveStatus}>
      <div className="flex flex-wrap items-center gap-3">
        <ToneChip tone={status.tone} icon={status.icon} label={status.label} spinning={status.spinning} />
        <span className="tabular text-sm text-fg-1">
          {done.toLocaleString('en-IN')} of {dto.rowCount.toLocaleString('en-IN')} rows processed
        </span>
      </div>
      <div role="progressbar" aria-label="Rows processed" aria-valuemin={0} aria-valuemax={dto.rowCount} aria-valuenow={done} className="h-2 overflow-hidden rounded-full bg-bg-3">
        <div className="h-full rounded-full bg-aura transition-[width] duration-300" style={{ width: `${percent}%` }} />
      </div>
      <p className="text-sm text-fg-2">The worker imports 200 rows at a time; this page updates by itself. You can leave it and come back.</p>
      {props.exhausted ? (
        <p role="status" className="text-sm text-fg-2">
          The import is taking longer than usual. Reload the page later; if it stays stuck, a super admin can check the job queue.
        </p>
      ) : null}
    </div>
  );
}

function groupNotes(notes: readonly ImportRowNote[]): Array<{ code: string; rows: number[] }> {
  const groups = new Map<string, number[]>();
  for (const note of notes) groups.set(note.code, [...(groups.get(note.code) ?? []), note.row]);
  return [...groups].map(([code, rows]) => ({ code, rows: rows.sort((a, b) => a - b) })).sort((a, b) => b.rows.length - a.rows.length);
}

function NoteGroups(props: { title: string; groups: Array<{ code: string; rows: number[] }> }) {
  if (props.groups.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-label={props.title}>
      <h3 className="text-sm font-medium text-fg-1">{props.title}</h3>
      <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle">
        {props.groups.map((g) => (
          <li key={g.code} data-note-code={g.code} className="flex flex-col gap-1 px-3 py-2 text-sm">
            <span className="text-fg-1">
              {importRowCodeLabel(g.code)}: {g.rows.length.toLocaleString('en-IN')} {g.rows.length === 1 ? 'row' : 'rows'}
            </span>
            <span className="tabular text-xs text-fg-2">
              Rows {g.rows.slice(0, ROWS_SHOWN).join(', ')}
              {g.rows.length > ROWS_SHOWN ? ` and ${(g.rows.length - ROWS_SHOWN).toLocaleString('en-IN')} more` : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ImportResult(props: { dto: LeadImportDto; consent: ConsentDecision | null; mappedConsent: boolean }) {
  const { dto } = props;
  const status = IMPORT_STATUS[dto.effectiveStatus];
  const rejected = groupNotes(dto.notes.filter((n) => !isConsentNoteCode(n.code)));
  const consentNotes = groupNotes(dto.notes.filter((n) => isConsentNoteCode(n.code)));
  const consentMessage = props.consent && !props.consent.honoured && props.consent.reason ? CONSENT_DECISION_LABELS[props.consent.reason] : null;
  return (
    <div className="flex flex-col gap-4" data-import-status={dto.effectiveStatus}>
      <div className="flex flex-wrap items-center gap-3">
        <ToneChip tone={status.tone} icon={status.icon} label={status.label} />
        <span className="text-sm text-fg-2">
          {dto.fileName}: {dto.rowCount.toLocaleString('en-IN')} {dto.rowCount === 1 ? 'row' : 'rows'}
        </span>
      </div>
      {dto.effectiveStatus === 'FAILED' ? (
        <p role="alert" className="text-sm text-danger">
          The import stopped before every row was processed. The rows already processed are counted below; upload the file again to import the rest (rows already imported come back as
          duplicates).
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile label={IMPORT_COUNT_LABELS.accepted} value={dto.counts.accepted.toLocaleString('en-IN')} icon={<UserPlus />} tone="success" />
        <StatTile label={IMPORT_COUNT_LABELS.duplicates} value={dto.counts.duplicates.toLocaleString('en-IN')} icon={<Copy />} tone="neutral" />
        <StatTile label={IMPORT_COUNT_LABELS.review} value={dto.counts.review.toLocaleString('en-IN')} icon={<GitMerge />} tone="warning" />
        <StatTile label={IMPORT_COUNT_LABELS.rejected} value={dto.counts.rejected.toLocaleString('en-IN')} icon={<XCircle />} tone={dto.counts.rejected > 0 ? 'danger' : 'neutral'} />
        {dto.consentAttested || props.mappedConsent ? (
          <StatTile label={IMPORT_COUNT_LABELS.consentRecorded} value={dto.counts.consentRecorded.toLocaleString('en-IN')} icon={<ShieldCheck />} tone="info" />
        ) : null}
      </div>
      {consentMessage ? <p className="text-sm text-fg-2">{consentMessage}</p> : null}
      {dto.effectiveStatus === 'SUCCEEDED' && rejected.length === 0 && consentNotes.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-fg-2">
          <CircleCheck aria-hidden="true" className="size-4 text-success" />
          Every row was processed without a problem.
        </p>
      ) : null}
      <NoteGroups title="Rows not imported" groups={rejected} />
      <NoteGroups title="Imported without a WhatsApp opt-in" groups={consentNotes} />
      <p className="text-xs text-fg-2">New leads are scored and enter the pipeline like leads from every other source. The uploaded rows were deleted once the import finished.</p>
    </div>
  );
}
