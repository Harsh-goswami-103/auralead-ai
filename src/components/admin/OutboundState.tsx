/**
 * The global outbound pause, shown the same way on Global metrics and on Jobs and queue (one read
 * model, readOutboundPause): a state chip ("Not paused" in the success tone, "Paused" in the
 * danger tone, each with its icon) and the three independent switches, each with its own on/off
 * chip and what lifts it, as a compact list (the admin home) or as three side-by-side switch
 * cards (`layout="grid"`, Jobs and queue). Labels avoid the bare word "Running" (the admin home's
 * worker state owns that word). Server-safe.
 */
import { CircleCheck, FileLock2, Flag, OctagonPause, ToggleRight, type LucideIcon } from 'lucide-react';
import type { StatusEntry } from '@/components/patterns/status-vocabulary';
import { cn } from '@/components/ui/cn';
import { formatDateTime } from '@/lib/format/date';
import type { OutboundPauseState } from '@/server/services/admin/outbound-pause';
import { TONE_NODE } from './admin-vocabulary';
import { StatusChip } from './StatusChip';

export const OUTBOUND_NOT_PAUSED: StatusEntry = { label: 'Not paused', tone: 'success', icon: CircleCheck };
export const OUTBOUND_PAUSED: StatusEntry = { label: 'Paused', tone: 'danger', icon: OctagonPause };

export function OutboundStateChip(props: { paused: boolean; size?: 'sm' | 'md'; className?: string }) {
  return <StatusChip entry={props.paused ? OUTBOUND_PAUSED : OUTBOUND_NOT_PAUSED} state={props.paused ? 'paused' : 'not-paused'} size={props.size} className={props.className} />;
}

/** Names of the switches that hold delivery right now, for a one-line summary. */
export function pauseSources(state: OutboundPauseState): string[] {
  const sources: string[] = [];
  if (state.db.paused) sources.push('the admin switch');
  if (state.lockFile.present) sources.push(state.lockFile.writtenByRestore ? 'outbound.lock (from a restore)' : 'outbound.lock');
  if (state.env.paused) sources.push('the OUTBOUND_PAUSED flag');
  return sources;
}

type Row = { key: string; icon: LucideIcon; name: string; on: boolean; onLabel: string; offLabel: string; detail?: string };

const chipEntry = (row: Row): StatusEntry => (row.on ? { label: row.onLabel, tone: 'danger', icon: OctagonPause } : { label: row.offLabel, tone: 'neutral', icon: CircleCheck });

export function OutboundSources(props: { state: OutboundPauseState; detailed?: boolean; layout?: 'list' | 'grid'; className?: string }) {
  const { state } = props;
  const rows: Row[] = [
    {
      key: 'db',
      icon: ToggleRight,
      name: 'Admin switch',
      on: state.db.paused,
      onLabel: 'On',
      offLabel: 'Off',
      detail: state.db.paused
        ? `On since ${state.db.at ? formatDateTime(state.db.at) : 'an unknown time'}${state.db.reason ? `. Reason: ${state.db.reason}` : '. No reason recorded'}`
        : 'Set and cleared here, with a reason, by a super admin.',
    },
    {
      key: 'lock',
      icon: FileLock2,
      name: 'outbound.lock',
      on: state.lockFile.present,
      onLabel: 'Present',
      offLabel: 'Absent',
      detail: state.lockFile.present
        ? state.lockFile.writtenByRestore
          ? 'Written by a database restore; removed when you resume.'
          : `Present at ${state.lockFile.path}; remove the file to lift it.`
        : 'Written by a database restore, or by an operator by hand.',
    },
    {
      key: 'env',
      icon: Flag,
      name: 'OUTBOUND_PAUSED flag',
      on: state.env.paused,
      onLabel: 'Set',
      offLabel: 'Not set',
      detail: state.env.paused ? 'Set in the environment; restart without it to lift.' : 'Environment flag read at start.',
    },
  ];
  if (props.layout === 'grid') {
    return (
      <ul className={cn('grid gap-3 md:grid-cols-3', props.className)}>
        {rows.map((row) => {
          const Icon = row.icon;
          return (
            // One grid, two arrangements: a compact row on phones (icon | name + detail | chip), a
            // card from md (icon and chip on top, then name and detail). DOM order stays name, chip.
            <li
              key={row.key}
              data-pause-source={row.key}
              data-on={row.on ? 'true' : 'false'}
              className={cn(
                'grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5 rounded-lg border bg-bg-0/40 p-3 md:grid-cols-[auto_minmax(0,1fr)] md:gap-y-2',
                row.on ? 'border-danger/45' : 'border-border-subtle',
              )}
            >
              <span
                aria-hidden="true"
                className={cn('col-start-1 row-span-2 row-start-1 flex size-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset md:row-span-1', TONE_NODE[row.on ? 'danger' : 'neutral'])}
              >
                <Icon className="size-4" />
              </span>
              <span className={cn('col-start-2 row-start-1 self-center text-sm font-medium text-fg-1 md:col-span-2 md:col-start-1 md:row-start-2', row.key !== 'db' && 'font-mono text-[13px]')}>
                {row.name}
              </span>
              <StatusChip entry={chipEntry(row)} state={row.on ? 'on' : 'off'} className="col-start-3 row-start-1 self-center md:col-start-2 md:justify-self-end" />
              {props.detailed && row.detail ? (
                <p className="col-span-2 col-start-2 row-start-2 text-xs [overflow-wrap:anywhere] text-fg-2 md:col-start-1 md:row-start-3">{row.detail}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <ul className={cn('flex flex-col divide-y divide-border-subtle overflow-hidden rounded-lg border border-border-subtle bg-bg-0/40', props.className)}>
      {rows.map((row) => {
        const Icon = row.icon;
        return (
          <li key={row.key} data-pause-source={row.key} data-on={row.on ? 'true' : 'false'} className="flex items-start gap-3 px-3 py-2.5">
            <span aria-hidden="true" className={cn('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md ring-1 ring-inset', TONE_NODE[row.on ? 'danger' : 'neutral'])}>
              <Icon className="size-3.5" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className={cn('text-sm font-medium text-fg-1', row.key !== 'db' && 'font-mono text-[13px]')}>{row.name}</span>
                <StatusChip entry={chipEntry(row)} state={row.on ? 'on' : 'off'} />
              </div>
              {props.detailed && row.detail ? <p className="text-xs [overflow-wrap:anywhere] text-fg-2">{row.detail}</p> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
