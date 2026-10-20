/**
 * Employee productivity (T25, P10; PRD "employee productivity with explicit definitions (no
 * invented efficiency scores)"). Five counts per employee read from the audit trail for the last
 * 7 or 30 days (`?days=`; anything else reads 7), each column linked to its definition printed
 * under the table, with the "As of" time and the period's start. There is no combined score and
 * no ranking; the page says so. Platform admin only (the admin layout answers 404 to any other
 * role, and the service refuses too).
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CalendarRange, Info, UsersRound } from 'lucide-react';
import { InlineEmpty } from '@/components/admin/InlineEmpty';
import { SectionTitle } from '@/components/admin/SectionTitle';
import { ProductivityTable } from '@/components/metrics/ProductivityTable';
import { RefreshButton } from '@/components/metrics/RefreshButton';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { cn } from '@/components/ui/cn';
import { formatDateTime } from '@/lib/format/date';
import { getPageContext } from '@/server/auth/page-context';
import { ACTIVE_ASSIGNMENTS_DEFINITION, loadProductivity, PRODUCTIVITY_PERIODS } from '@/server/services/metrics/productivity';

export const metadata: Metadata = { title: 'Employee productivity' };
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ProductivityPage(props: { searchParams?: SearchParams }) {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const sp = (await props.searchParams) ?? {};
  const raw = Array.isArray(sp.days) ? sp.days[0] : sp.days;
  const data = await loadProductivity(page.ctx, { days: Number(raw ?? '') });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Platform admin"
        title="Employee productivity"
        description="What each employee did, counted from the audit trail. Every column has its definition below the table."
        meta={`As of ${formatDateTime(data.asOf)}. Period: ${formatDateTime(data.since)} to now.`}
        actions={<RefreshButton />}
      />

      <nav aria-label="Period" className="flex flex-wrap items-center gap-2">
        <CalendarRange aria-hidden="true" className="size-4 text-fg-2" />
        <span className="text-sm text-fg-2">Period</span>
        <span className="inline-flex gap-1 rounded-full border border-border-subtle bg-bg-1/80 p-1">
          {PRODUCTIVITY_PERIODS.map((days) => {
            const current = days === data.days;
            return (
              <Link
                key={days}
                href={`/dashboard/admin/productivity?days=${days}`}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'inline-flex min-h-11 items-center rounded-full px-3.5 text-sm font-medium transition-colors duration-fast lg:min-h-8',
                  current ? 'bg-panel/14 text-fg-1 ring-1 ring-panel/40 ring-inset' : 'text-fg-2 hover:text-fg-1',
                )}
              >
                Last {days} days
              </Link>
            );
          })}
        </span>
      </nav>

      <SectionCard
        accent
        title={
          <SectionTitle icon={<UsersRound />} hue="volt">
            Employees
          </SectionTitle>
        }
        meta={`${data.rows.length.toLocaleString('en-IN')} ${data.rows.length === 1 ? 'employee' : 'employees'}, listed by name.`}
      >
        <p className="flex items-start gap-2 rounded-lg border border-info/35 bg-info/8 px-3 py-2.5 text-sm text-fg-1">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-info" />
          These are separate counts, not a score: they are not combined or ranked. Read each with its definition; the work available depends on the workspaces a person is assigned to.
        </p>
        {data.rows.length === 0 ? (
          <InlineEmpty icon={<UsersRound />}>No employee accounts yet.</InlineEmpty>
        ) : (
          <ProductivityTable rows={data.rows} definitions={data.definitions} assignmentsDefinition={ACTIVE_ASSIGNMENTS_DEFINITION} />
        )}
      </SectionCard>
    </div>
  );
}
