/**
 * The two tabs of the Leads area (T26): the leads themselves and the scoring configuration (P9:
 * editable in the operator console, read-only for the workspace owner). Links, so each tab has its
 * own URL; the current one carries aria-current. Server-safe.
 */
import Link from 'next/link';
import { Gauge, Users } from 'lucide-react';
import { cn } from '@/components/ui/cn';

export function LeadsTabs(props: { current: 'leads' | 'scoring'; leadsHref: string; scoringHref: string }) {
  const tab = (key: 'leads' | 'scoring', href: string, label: string, Icon: typeof Users) => {
    const active = props.current === key;
    return (
      <Link
        href={href}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'relative inline-flex min-h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors duration-fast',
          active ? 'bg-bg-3 text-fg-1' : 'text-fg-2 hover:bg-bg-2 hover:text-fg-1',
        )}
      >
        <Icon aria-hidden="true" className={cn('size-4', active ? 'text-panel' : 'text-fg-3')} />
        {label}
      </Link>
    );
  };
  return (
    <nav aria-label="Leads sections" className="flex w-fit items-center gap-1 rounded-lg border border-border-subtle bg-bg-1/80 p-1">
      {tab('leads', props.leadsHref, 'Leads', Users)}
      {tab('scoring', props.scoringHref, 'Scoring', Gauge)}
    </nav>
  );
}
