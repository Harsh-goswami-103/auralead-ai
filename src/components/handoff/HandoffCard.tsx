/**
 * HandoffCard (ADR-124, lead-gen F5): a handed-over lead as both panels show it. The status chip
 * (Handed over / Acknowledged), who handed it over and when, the operator's note, the summary (what
 * the customer asked, what was promised, the next step) with its provenance chip (AiProvenance:
 * violet "AI prepared" only for a real model; "Local template" for the DEMO generator), or the
 * summary's status when there is none, and who acknowledged it. `audience` words the read-only
 * state for the operator; `actions` holds the client's Acknowledge. Server-safe.
 */
import type { ReactNode } from 'react';
import { ListChecks, NotebookPen } from 'lucide-react';
import { AiProvenance } from '@/components/ai/AiProvenance';
import { ToneChip } from '@/components/leads/ToneChip';
import { formatDateTime } from '@/lib/format/date';
import { HANDOFF_SUMMARY_LABELS, type HandoffSummaryContent, type LeadHandoffDto } from '@/lib/schemas/handoff';
import { HANDOFF_STATUS_CHIPS, SUMMARY_STATUS_CHIPS, SUMMARY_STATUS_HELP } from './handoff-vocabulary';

const SUMMARY_FIELDS: ReadonlyArray<keyof HandoffSummaryContent> = ['asked', 'promised', 'nextStep'];

export function HandoffCard(props: { handoff: LeadHandoffDto; timeZone: string; audience: 'client' | 'operator'; actions?: ReactNode }) {
  const { handoff, timeZone } = props;
  const status = HANDOFF_STATUS_CHIPS[handoff.status];
  const summaryStatus = SUMMARY_STATUS_CHIPS[handoff.summaryStatus];
  const by = handoff.fromUserName ? ` by ${handoff.fromUserName}` : '';
  return (
    <article data-handoff-id={handoff.id} data-handoff-status={handoff.status} className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ToneChip tone={status.tone} icon={status.icon} label={status.label} size="md" />
        <span className="text-sm text-fg-2">
          Handed over{by} on {formatDateTime(new Date(handoff.createdAt), timeZone)}
        </span>
      </header>
      <p className="text-sm text-fg-1">
        {props.audience === 'operator'
          ? 'This lead belongs to the client now. You can read it, but you can no longer message it, approve its drafts or change its conversations.'
          : 'Your AuraLead operator passed this lead to your team. AI replies are off on its conversations, so you continue the chat and the quotation yourselves.'}
      </p>

      <section aria-label="Note from the operator" className="flex flex-col gap-1.5">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-fg-2">
          <NotebookPen aria-hidden="true" className="size-3.5" />
          Note from the operator
        </h3>
        {handoff.note ? (
          <p className="rounded-lg border border-border-subtle bg-bg-2/60 px-3.5 py-2.5 text-sm whitespace-pre-line text-fg-1">{handoff.note}</p>
        ) : (
          <p className="text-sm text-fg-2">No note was added.</p>
        )}
      </section>

      <section aria-label="Summary" className="flex flex-col gap-2">
        <h3 className="flex flex-wrap items-center gap-2 text-xs font-medium text-fg-2">
          <span className="flex items-center gap-1.5">
            <ListChecks aria-hidden="true" className="size-3.5" />
            Summary
          </span>
          {handoff.summary ? <AiProvenance generatorLabel={handoff.summaryGeneratorLabel} /> : <ToneChip tone={summaryStatus.tone} icon={summaryStatus.icon} label={summaryStatus.label} spinning={summaryStatus.spinning} />}
        </h3>
        {handoff.summary ? (
          <dl className="grid gap-2.5 rounded-lg border border-border-subtle bg-bg-2/40 px-3.5 py-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-4">
            {SUMMARY_FIELDS.map((field) => (
              <div key={field} className="contents">
                <dt className="text-fg-2">{HANDOFF_SUMMARY_LABELS[field]}</dt>
                <dd className="text-fg-1">{handoff.summary![field]}</dd>
              </div>
            ))}
          </dl>
        ) : handoff.summaryStatus !== 'READY' ? (
          <p className="text-sm text-fg-2">{SUMMARY_STATUS_HELP[handoff.summaryStatus]}</p>
        ) : (
          <p className="text-sm text-fg-2">The summary could not be read. Read the conversation instead.</p>
        )}
      </section>

      {handoff.acknowledgedAt ? (
        <p className="text-sm text-fg-2">
          Acknowledged{handoff.acknowledgedByName ? ` by ${handoff.acknowledgedByName}` : ''} on {formatDateTime(new Date(handoff.acknowledgedAt), timeZone)}
        </p>
      ) : null}
      {props.actions ? <div className="flex flex-wrap items-start gap-2">{props.actions}</div> : null}
    </article>
  );
}
