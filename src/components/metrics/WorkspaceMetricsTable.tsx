/**
 * The admin workspace table (T25; 06-design §11.1 "Global metrics with workspace table"): one row
 * per workspace of this mode with its status (icon + label), people and operators, leads (and new
 * in 7 days), open conversations, drafts awaiting approval, pipeline value, accepted quote value
 * and the time of its newest audit entry. Numbers only, never tenant records. Column headers point
 * at the numbered definitions printed under the table. The table scrolls inside its region on
 * narrow screens (the page never scrolls sideways). Server-safe.
 */
import type { ReactNode } from 'react';
import { CircleCheck, CircleSlash, PauseCircle } from 'lucide-react';
import { TONE_CLASSES } from '@/components/patterns/status-vocabulary';
import { cn } from '@/components/ui/cn';
import { formatDateTime } from '@/lib/format/date';
import { formatINR } from '@/lib/money';
import { DefinitionList, FootnoteRef } from './DefinitionList';

export type WorkspaceTableRow = {
  id: string;
  slug: string;
  name: string;
  planLabel: string;
  status: 'ACTIVE' | 'SUSPENDED';
  automationPaused: boolean;
  people: number;
  activeAssignments: number;
  leads: number;
  newLeads: number;
  openConversations: number;
  quotesAwaitingApproval: number;
  pipelineValue: { paise: bigint; count: number };
  acceptedQuoteValue: { paise: bigint; count: number };
  lastActivityAt: Date | null;
};

type Definition = { id: string; label: string; definition: string };

const PREFIX = 'ws';
const pill = 'inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap';
const num = (n: number) => n.toLocaleString('en-IN');

function Th(props: { children: ReactNode; right?: boolean; def?: { d: Definition; n: number } }) {
  return (
    <th scope="col" className={cn('px-3 py-3 font-medium whitespace-nowrap first:pl-4 last:pr-4', props.right && 'text-right')}>
      {props.children}
      {props.def ? <FootnoteRef prefix={PREFIX} id={props.def.d.id} n={props.def.n} label={props.def.d.label} /> : null}
    </th>
  );
}

export function WorkspaceMetricsTable(props: {
  rows: WorkspaceTableRow[];
  definitions: { people: Definition; assignments: Definition; leads: Definition; newLeads: Definition; openConversations: Definition; quotesAwaitingApproval: Definition; pipelineValue: Definition; acceptedQuoteValue: Definition; lastActivity: Definition };
}) {
  const d = props.definitions;
  const order = [d.people, d.assignments, d.leads, d.newLeads, d.openConversations, d.quotesAwaitingApproval, d.pipelineValue, d.acceptedQuoteValue, d.lastActivity];
  const n = (def: Definition) => ({ d: def, n: order.indexOf(def) + 1 });
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div role="region" aria-label="Workspace metrics table" tabIndex={0} className="relative overflow-x-auto rounded-lg border border-border-subtle focus-visible:outline-offset-2">
        <table className="w-full min-w-[68rem] text-left text-sm">
          <caption className="sr-only">One row per workspace with its counts and quote values</caption>
          <thead className="bg-bg-2/50 text-xs text-fg-2">
            <tr className="border-b border-border-subtle">
              <Th>Workspace</Th>
              <Th>Status</Th>
              <Th right def={n(d.people)}>
                People
              </Th>
              <Th right def={n(d.assignments)}>
                Operators
              </Th>
              <Th right def={n(d.leads)}>
                Leads
              </Th>
              <Th right def={n(d.newLeads)}>
                New (7 days)
              </Th>
              <Th right def={n(d.openConversations)}>
                Open conversations
              </Th>
              <Th right def={n(d.quotesAwaitingApproval)}>
                Awaiting approval
              </Th>
              <Th right def={n(d.pipelineValue)}>
                Pipeline value
              </Th>
              <Th right def={n(d.acceptedQuoteValue)}>
                Accepted quote value
              </Th>
              <Th def={n(d.lastActivity)}>Last activity</Th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((w) => (
              <tr key={w.id} className="border-b border-border-subtle align-top transition-colors duration-fast last:border-b-0 hover:bg-bg-2/40">
                <th scope="row" className="py-3 pr-3 pl-4 text-left font-normal">
                  <span className="block font-medium text-fg-1">{w.name}</span>
                  <span className="block font-mono text-[11px] text-fg-3">{w.slug}</span>
                  <span className="block text-xs text-fg-2">{w.planLabel} plan</span>
                </th>
                <td className="px-3 py-3">
                  <span className="flex flex-col gap-1">
                    {w.status === 'ACTIVE' ? (
                      <span className={cn(pill, TONE_CLASSES.success)}>
                        <CircleCheck aria-hidden="true" className="size-3.5" />
                        Active
                      </span>
                    ) : (
                      <span className={cn(pill, TONE_CLASSES.danger)}>
                        <CircleSlash aria-hidden="true" className="size-3.5" />
                        Suspended
                      </span>
                    )}
                    {w.automationPaused ? (
                      <span className={cn(pill, TONE_CLASSES.warning)}>
                        <PauseCircle aria-hidden="true" className="size-3.5" />
                        Automation paused
                      </span>
                    ) : null}
                  </span>
                </td>
                <td className="tabular px-3 py-3 text-right text-fg-1">{num(w.people)}</td>
                <td className="tabular px-3 py-3 text-right text-fg-1">{num(w.activeAssignments)}</td>
                <td className="tabular px-3 py-3 text-right text-fg-1">{num(w.leads)}</td>
                <td className="tabular px-3 py-3 text-right text-fg-1">{num(w.newLeads)}</td>
                <td className="tabular px-3 py-3 text-right text-fg-1">{num(w.openConversations)}</td>
                <td className="tabular px-3 py-3 text-right text-fg-1">{num(w.quotesAwaitingApproval)}</td>
                <td className="tabular px-3 py-3 text-right whitespace-nowrap text-fg-1">
                  {formatINR(w.pipelineValue.paise)}
                  <span className="block text-xs text-fg-2">{num(w.pipelineValue.count)} open</span>
                </td>
                <td className="tabular px-3 py-3 text-right whitespace-nowrap text-fg-1">
                  {formatINR(w.acceptedQuoteValue.paise)}
                  <span className="block text-xs text-fg-2">{num(w.acceptedQuoteValue.count)} accepted</span>
                </td>
                <td className="py-3 pr-4 pl-3 whitespace-nowrap text-fg-2">{w.lastActivityAt ? formatDateTime(w.lastActivityAt) : 'No activity yet'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <DefinitionList title="How these columns are counted" prefix={PREFIX} items={order} />
    </div>
  );
}
