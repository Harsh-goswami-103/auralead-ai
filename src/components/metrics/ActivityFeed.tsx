/**
 * Recent activity (06-design §11.1 "activity feed (from AuditEvent)"): the workspace's latest
 * audit entries as sentences with who did it and when (workspace time zone). A quotation or a
 * conversation links to its page; other targets have no page of their own in the client panel.
 * A denied or failed attempt says so with an icon and a word; a platform-admin action is marked.
 * No payload or personal data is shown: the audit summary is never rendered. Server-safe.
 */
import Link from 'next/link';
import { CircleX, ShieldAlert } from 'lucide-react';
import { TONE_CLASSES } from '@/components/patterns/status-vocabulary';
import { cn } from '@/components/ui/cn';
import { formatDateTime } from '@/lib/format/date';
import { activityIcon, activityLabel, actorLabel } from './activity-vocabulary';

export type ActivityEntry = {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  actorKind: string;
  actorName: string | null;
  result: string;
  crossWorkspace: boolean;
  createdAt: Date;
};

function targetHref(entry: ActivityEntry): string | null {
  if (entry.targetType === 'Quote') return `/dashboard/user/quotations/${encodeURIComponent(entry.targetId)}`;
  if (entry.targetType === 'Conversation') return `/dashboard/user/inbox/${encodeURIComponent(entry.targetId)}`;
  // The handoff audits (lead.handoff, .summary, .acknowledge) target the Lead (lead-gen F5).
  if (entry.targetType === 'Lead') return `/dashboard/user/leads/${encodeURIComponent(entry.targetId)}`;
  return null;
}

const pill = 'inline-flex w-fit items-center gap-1 rounded-full border px-1.5 py-px text-[11px] font-medium';

export function ActivityFeed(props: { entries: ActivityEntry[]; timeZone: string }) {
  return (
    <ol className="flex flex-col">
      {props.entries.map((entry) => {
        const Icon = activityIcon(entry.action);
        const href = targetHref(entry);
        const label = activityLabel(entry.action);
        return (
          <li key={entry.id} className="flex items-start gap-3 border-b border-border-subtle py-2.5 last:border-b-0">
            <span aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-bg-2 text-fg-2 ring-1 ring-border-strong [&>svg]:size-3.5">
              <Icon />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {href ? (
                  <Link href={href} className="font-medium text-cyan underline-offset-4 hover:underline">
                    {label}
                  </Link>
                ) : (
                  <span className="font-medium text-fg-1">{label}</span>
                )}
                {entry.result !== 'SUCCESS' ? (
                  <span className={cn(pill, TONE_CLASSES.danger)}>
                    <CircleX aria-hidden="true" className="size-3" />
                    {entry.result === 'DENIED' ? 'Denied' : 'Failed'}
                  </span>
                ) : null}
                {entry.crossWorkspace ? (
                  <span className={cn(pill, TONE_CLASSES.warning)}>
                    <ShieldAlert aria-hidden="true" className="size-3" />
                    Platform admin
                  </span>
                ) : null}
              </span>
              <span className="text-xs text-fg-2">
                {actorLabel(entry.actorName, entry.actorKind)} · <time dateTime={entry.createdAt.toISOString()}>{formatDateTime(entry.createdAt, props.timeZone)}</time>
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
