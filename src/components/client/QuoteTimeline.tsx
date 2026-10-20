/**
 * A quotation's state timeline as a colored rail (design spec §6; user report bug "raw audit codes
 * in the timeline"). Every audit action the quote services emit has a label, an icon and a hue:
 * status-like moves use their status tone (approved and accepted success, sent and opened info,
 * expired warning), housekeeping uses the aurora brand hues (created aura, new version volt, link
 * and PDF ice). An unknown action falls back to a humanised label, so a dotted code never reaches
 * the screen. Each entry's label and version stay in one span ("Sent (v1)"); icons are aria-hidden.
 * The first 8 entries rise in 30ms apart, static under reduced motion. Server-safe.
 */
import { BadgeCheck, CircleSlash, Clock, Eye, FileCheck2, FilePlus2, FileText, History, Link2, PencilLine, Send, Unlink, type LucideIcon } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { Reveal } from '@/components/visual/Reveal';
import { humanize } from './labels';

type Hue = 'panel' | 'volt' | 'ice' | 'success' | 'info' | 'warning' | 'neutral';

const HUES: Readonly<Record<Hue, string>> = {
  panel: 'text-panel ring-panel/45 before:bg-panel/12',
  volt: 'text-volt-hi ring-volt-hi/45 before:bg-volt-hi/14',
  ice: 'text-ice ring-ice/40 before:bg-ice/10',
  success: 'text-success ring-success/45 before:bg-success/12',
  info: 'text-info ring-info/45 before:bg-info/12',
  warning: 'text-warning ring-warning/45 before:bg-warning/12',
  neutral: 'text-fg-2 ring-border-strong before:bg-bg-3',
};

export const QUOTE_AUDIT_ACTIONS: Readonly<Record<string, { label: string; icon: LucideIcon; hue: Hue }>> = {
  'quote.create': { label: 'Created as a draft', icon: FilePlus2, hue: 'panel' },
  'quote.revise': { label: 'New version saved', icon: PencilLine, hue: 'volt' },
  'quote.approve': { label: 'Approved', icon: FileCheck2, hue: 'success' },
  'quote.cancel': { label: 'Cancelled', icon: CircleSlash, hue: 'neutral' },
  'quote.expire': { label: 'Expired (validity date passed)', icon: Clock, hue: 'warning' },
  'quote.share.create': { label: 'Share link created', icon: Link2, hue: 'ice' },
  'quote.share.revoke': { label: 'Share link revoked', icon: Unlink, hue: 'neutral' },
  'quote.send': { label: 'Sent', icon: Send, hue: 'info' },
  'quote.view': { label: 'Opened (may be automated)', icon: Eye, hue: 'info' },
  'quote.view.unsent': { label: 'A link was opened before it was marked as sent', icon: Eye, hue: 'warning' },
  'quote.accept': { label: 'Accepted', icon: BadgeCheck, hue: 'success' },
  'quote.pdf.render': { label: 'PDF ready', icon: FileText, hue: 'ice' },
  'quote.sent_superseded_version': { label: 'An older version was sent', icon: History, hue: 'warning' },
};

export function quoteAuditLabel(action: string): string {
  return QUOTE_AUDIT_ACTIONS[action]?.label ?? humanize(action);
}

export type QuoteTimelineItem = { id: string; action: string; versionNo: number | null; when: string; who: string };

export function QuoteTimeline(props: { items: QuoteTimelineItem[]; className?: string }) {
  return (
    <ol
      className={cn(
        'relative flex flex-col gap-4 before:absolute before:top-4 before:bottom-4 before:left-3.5 before:w-px before:bg-[linear-gradient(to_bottom,var(--panel-hue),color-mix(in_oklab,var(--panel-hue-2)_55%,transparent)_70%,transparent)]',
        props.className,
      )}
    >
      {props.items.map((t, i) => {
        const meta = QUOTE_AUDIT_ACTIONS[t.action];
        const Icon = meta?.icon ?? History;
        const label = `${meta?.label ?? humanize(t.action)}${t.versionNo !== null ? ` (v${t.versionNo})` : ''}`;
        return (
          <li key={t.id} className="relative pl-10 text-sm">
            <Reveal delay={i < 8 ? i * 0.03 : 0} variant={i < 8 ? 'rise' : 'fade'} className="relative">
              <span
                aria-hidden="true"
                className={cn(
                  'absolute top-0 -left-10 flex size-7 items-center justify-center rounded-full bg-bg-1 ring-1 before:absolute before:inset-0 before:rounded-full [&>svg]:relative [&>svg]:size-3.5',
                  HUES[meta?.hue ?? 'neutral'],
                )}
              >
                <Icon />
              </span>
              <span className="block font-medium text-fg-1">{label}</span>
              <span className="block text-xs text-fg-2">
                {t.when} · {t.who}
              </span>
            </Reveal>
          </li>
        );
      })}
    </ol>
  );
}
