/**
 * The pipeline page's persisted facts (T28; 06-design §11.2.2 "persisted versions and execution
 * status per stage"): every saved version (active one marked with icon + label, its stages, its
 * approval mode, who saved it and when) and, per stage, how many runs are done, waiting, running,
 * skipped or failed in this workspace. Real counts, final values, no animation. Tables scroll
 * inside their card. Server-safe.
 */
import { CircleCheck, History } from 'lucide-react';
import type { PipelineApprovalMode, PipelineStage } from '@/lib/domain/enums';
import { formatDateTime } from '@/lib/format/date';
import { APPROVAL_MODE_LABELS, STAGE_INFO, STAGE_ORDER } from './pipeline-model';

export type VersionRow = { id: string; version: number; approvalMode: PipelineApprovalMode; active: boolean; stages: PipelineStage[]; createdAt: Date; createdByName: string | null };
export type StatsRow = { done: number; pending: number; running: number; skipped: number; failed: number };

export function VersionHistory({ versions, timeZone }: { versions: VersionRow[]; timeZone: string }) {
  return (
    <div className="relative overflow-x-auto rounded-lg border border-border-subtle">
      <table className="w-full min-w-[40rem] text-left text-sm">
        <caption className="sr-only">Saved pipeline versions</caption>
        <thead className="bg-bg-2/60 text-xs text-fg-2">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Version
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Stages
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Approval
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Saved
            </th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.id} data-version={v.version} data-active={v.active ? 'true' : undefined} className="border-t border-border-subtle">
              <th scope="row" className="px-3 py-2 font-normal">
                <span className="flex items-center gap-2">
                  <span className="tabular font-medium text-fg-1">v{v.version}</span>
                  {v.active ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-success/35 bg-success/12 px-2 py-0.5 text-xs font-medium text-success">
                      <CircleCheck aria-hidden="true" className="size-3.5" />
                      Active
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full border border-border-strong bg-bg-2 px-2 py-0.5 text-xs text-fg-2">
                      <History aria-hidden="true" className="size-3.5" />
                      Earlier
                    </span>
                  )}
                </span>
              </th>
              <td className="px-3 py-2 text-fg-1">{v.stages.map((s) => STAGE_INFO[s].label).join(' → ')}</td>
              <td className="px-3 py-2 text-fg-1">{APPROVAL_MODE_LABELS[v.approvalMode]}</td>
              <td className="px-3 py-2 text-xs text-fg-2">
                {formatDateTime(v.createdAt, timeZone)}
                {v.createdByName ? ` by ${v.createdByName}` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StageStatsTable({ stats }: { stats: Record<PipelineStage, StatsRow> }) {
  return (
    <div className="relative overflow-x-auto rounded-lg border border-border-subtle">
      <table className="w-full min-w-[34rem] text-left text-sm">
        <caption className="sr-only">Stage runs in this workspace</caption>
        <thead className="bg-bg-2/60 text-xs text-fg-2">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Stage
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Done
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Waiting or running
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Skipped
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Failed
            </th>
          </tr>
        </thead>
        <tbody>
          {STAGE_ORDER.map((stage) => {
            const s = stats[stage];
            return (
              <tr key={stage} data-stage-stats={stage} className="tabular border-t border-border-subtle">
                <th scope="row" className="px-3 py-2 font-normal text-fg-1">
                  {STAGE_INFO[stage].label}
                </th>
                <td className="px-3 py-2 text-right text-fg-1">{s.done}</td>
                <td className="px-3 py-2 text-right text-fg-1">{s.pending + s.running}</td>
                <td className="px-3 py-2 text-right text-fg-1">{s.skipped}</td>
                <td className="px-3 py-2 text-right text-fg-1">{s.failed}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
