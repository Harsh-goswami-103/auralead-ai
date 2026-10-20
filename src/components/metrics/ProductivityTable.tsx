/**
 * Employee productivity table (T25, P10; 06-design §11.1 "productivity (each metric has a
 * definition footnote)"). One row per employee, the five audit-derived metrics side by side in
 * the service's order, each column header linked to its numbered definition printed under the
 * table. No column combines them and rows keep the service's name order: this is not a ranking.
 * The median shows how many decisions it is based on. Scrolls inside its region on narrow screens.
 * Server-safe.
 */
import type { ReactNode } from 'react';
import { CircleSlash, MailQuestion } from 'lucide-react';
import { TONE_CLASSES } from '@/components/patterns/status-vocabulary';
import { cn } from '@/components/ui/cn';
import { DefinitionList, FootnoteRef } from './DefinitionList';

export type ProductivityTableRow = {
  userId: string;
  name: string;
  status: 'INVITED' | 'ACTIVE' | 'DISABLED';
  activeAssignments: number;
  leadsProcessed: number;
  approvalsDecided: number;
  medianTimeToDecisionMs: number | null;
  decisionsTimed: number;
  messagesDispatched: number;
  quotesAcceptedAttributed: number;
};

type Definition = { id: string; label: string; definition: string };

const PREFIX = 'prod';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "45 min", "4 h", "4 h 30 min", "2 d 3 h"; under a minute is "under 1 min". */
export function formatDuration(ms: number): string {
  if (ms < MINUTE) return 'under 1 min';
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / MINUTE);
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  return `${m} min`;
}

const num = (n: number) => n.toLocaleString('en-IN');
const pill = 'inline-flex w-fit items-center gap-1 rounded-full border px-1.5 py-px text-[11px] font-medium';

function Th(props: { children: ReactNode; def?: { d: Definition; n: number }; left?: boolean }) {
  return (
    <th scope="col" className={cn('px-3 py-3 font-medium whitespace-nowrap first:pl-4 last:pr-4', props.left ? 'text-left' : 'text-right')}>
      {props.children}
      {props.def ? <FootnoteRef prefix={PREFIX} id={props.def.d.id} n={props.def.n} label={props.def.d.label} /> : null}
    </th>
  );
}

export function ProductivityTable(props: { rows: ProductivityTableRow[]; definitions: readonly Definition[]; assignmentsDefinition: Definition }) {
  const all = [props.assignmentsDefinition, ...props.definitions];
  const ref = (id: string) => {
    const index = all.findIndex((x) => x.id === id);
    return index < 0 ? undefined : { d: all[index]!, n: index + 1 };
  };
  const label = (id: string) => all.find((x) => x.id === id)?.label ?? id;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div role="region" aria-label="Employee productivity table" tabIndex={0} className="relative overflow-x-auto rounded-lg border border-border-subtle focus-visible:outline-offset-2">
        <table className="w-full min-w-[56rem] text-sm">
          <caption className="sr-only">One row per employee; each column is a separate count with its definition below the table</caption>
          <thead className="bg-bg-2/50 text-xs text-fg-2">
            <tr className="border-b border-border-subtle">
              <Th left>Employee</Th>
              <Th def={ref('assignments')}>{label('assignments')}</Th>
              <Th def={ref('leadsProcessed')}>{label('leadsProcessed')}</Th>
              <Th def={ref('approvalsDecided')}>{label('approvalsDecided')}</Th>
              <Th def={ref('medianTimeToDecision')}>{label('medianTimeToDecision')}</Th>
              <Th def={ref('messagesDispatched')}>{label('messagesDispatched')}</Th>
              <Th def={ref('quotesAcceptedAttributed')}>{label('quotesAcceptedAttributed')}</Th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((r) => (
              <tr key={r.userId} className="border-b border-border-subtle align-top transition-colors duration-fast last:border-b-0 hover:bg-bg-2/40">
                <th scope="row" className="py-3 pr-3 pl-4 text-left font-normal">
                  <span className="block font-medium text-fg-1">{r.name}</span>
                  {r.status === 'DISABLED' ? (
                    <span className={cn(pill, TONE_CLASSES.neutral)}>
                      <CircleSlash aria-hidden="true" className="size-3" />
                      Disabled
                    </span>
                  ) : r.status === 'INVITED' ? (
                    <span className={cn(pill, TONE_CLASSES.info)}>
                      <MailQuestion aria-hidden="true" className="size-3" />
                      Invited, not signed in
                    </span>
                  ) : null}
                </th>
                <td className="tabular px-3 py-3 text-right text-fg-1">{num(r.activeAssignments)}</td>
                <td className="tabular px-3 py-3 text-right text-fg-1">{num(r.leadsProcessed)}</td>
                <td className="tabular px-3 py-3 text-right text-fg-1">{num(r.approvalsDecided)}</td>
                <td className="tabular px-3 py-3 text-right whitespace-nowrap text-fg-1">
                  {r.medianTimeToDecisionMs === null ? <span className="text-fg-2">No timed decisions</span> : formatDuration(r.medianTimeToDecisionMs)}
                  {r.decisionsTimed > 0 ? <span className="block text-xs text-fg-2">from {r.decisionsTimed === 1 ? '1 decision' : `${num(r.decisionsTimed)} decisions`}</span> : null}
                </td>
                <td className="tabular px-3 py-3 text-right text-fg-1">{num(r.messagesDispatched)}</td>
                <td className="tabular py-3 pr-4 pl-3 text-right text-fg-1">{num(r.quotesAcceptedAttributed)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <DefinitionList title="How each column is counted" prefix={PREFIX} items={all} />
    </div>
  );
}
