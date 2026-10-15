/**
 * Operator panel home (T09, M1): the workspaces this employee is actively assigned to, with the
 * capabilities and discount cap each assignment grants. Read through the server context; the
 * browser supplies nothing but the session cookie.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Building2 } from 'lucide-react';
import { EmptyState } from '@/components/patterns/EmptyState';
import { formatDate } from '@/lib/format/date';
import { getPageContext } from '@/server/auth/page-context';
import { loadEmployeeHome } from '@/server/services/shell/panel-home';

export const metadata: Metadata = { title: 'Assignments' };
export const dynamic = 'force-dynamic';

export default async function EmployeeHomePage() {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const home = await loadEmployeeHome(page.ctx);
  const count = home.assignments.length;
  const inactive = home.inactiveCount;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-fg-2">Operator panel</p>
        <h1 className="font-display text-2xl font-semibold text-fg-1 sm:text-3xl">Assignments</h1>
        <p className="text-fg-2">
          {page.session.user.name}, you are assigned to {count} {count === 1 ? 'workspace' : 'workspaces'}.
          {inactive > 0 ? ` ${inactive} earlier ${inactive === 1 ? 'assignment is' : 'assignments are'} inactive.` : ''}
        </p>
      </header>

      {count === 0 ? (
        <EmptyState
          icon={<Building2 aria-hidden="true" className="size-5" />}
          title="No workspace assigned"
          description="A super admin assigns workspaces and capabilities to employees. Active assignments appear here, and in the workspace switcher, as soon as they are granted."
        />
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {home.assignments.map((a) => (
            <li key={a.slug} className="flex flex-col gap-4 rounded-xl border border-border-subtle bg-bg-1 p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex flex-col gap-0.5">
                  <h2 className="font-display text-lg font-semibold text-fg-1">{a.name}</h2>
                  <p className="text-sm text-fg-2">
                    {a.planLabel} plan · assigned {formatDate(a.since)}
                  </p>
                </div>
                {a.current ? <span className="rounded-full border border-primary/50 px-2 py-0.5 text-xs text-primary">Current workspace</span> : null}
              </div>
              <dl className="flex justify-between gap-4 text-sm">
                <dt className="text-fg-2">Discount you may give</dt>
                <dd className="tabular text-fg-1">{a.maxDiscountBps === null ? 'Workspace limit' : `up to ${(a.maxDiscountBps / 100).toLocaleString('en-IN')}%`}</dd>
              </dl>
              <div className="flex flex-col gap-2">
                <h3 className="text-xs font-medium text-fg-2">Capabilities ({a.capabilities.length})</h3>
                {a.capabilities.length === 0 ? (
                  <p className="text-sm text-fg-2">None granted.</p>
                ) : (
                  <ul aria-label={`Capabilities in ${a.name}`} className="flex flex-wrap gap-1.5">
                    {a.capabilities.map((c) => (
                      <li key={c} className="rounded-md border border-border-subtle bg-bg-2 px-2 py-0.5 font-mono text-xs text-fg-1">
                        {c}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
