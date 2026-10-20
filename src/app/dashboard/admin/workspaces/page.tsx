/**
 * Platform admin: workspaces (T29, R33). Creates a workspace in this installation's mode with its
 * first owner (invite link shown once), and lists every workspace of this mode with its owners,
 * members, active employee assignments and pending invites. Rows open the workspace page (access,
 * invites, plan label and the audited drilldown). Platform metadata only: no tenant records here.
 *
 * Look (design spec §6): PageHeader, the create form in an accent SectionCard, then a neutral
 * table (owners by name, counts in tabular figures) that becomes a divided list on phones; the
 * empty state of a fresh LIVE installation points at the form above.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Building2, Crown, Plus } from 'lucide-react';
import { CreateWorkspaceForm } from '@/components/admin/CreateWorkspaceForm';
import { ScrollRegion } from '@/components/admin/ScrollRegion';
import { SectionTitle } from '@/components/admin/SectionTitle';
import { EmptyState } from '@/components/patterns/EmptyState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { cn } from '@/components/ui/cn';
import { formatDate } from '@/lib/format/date';
import { getPageContext } from '@/server/auth/page-context';
import { listWorkspaces, type AdminWorkspaceRow } from '@/server/services/admin/workspaces';

export const metadata: Metadata = { title: 'Workspaces' };
export const dynamic = 'force-dynamic';

const ROW_FOCUS = 'focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-aura';

function Owners({ row }: { row: AdminWorkspaceRow }) {
  if (row.owners.length > 0) return <span className="text-fg-1">{row.owners.map((o) => o.name).join(', ')}</span>;
  return <span className="text-fg-2">{row.pendingInvites > 0 ? 'Owner invite pending' : 'No owner yet'}</span>;
}

export default async function AdminWorkspacesPage() {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const rows = await listWorkspaces(page.ctx);
  const mode = page.ctx.mode;
  const modeLabel = mode === 'live' ? 'LIVE' : 'DEMO';

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Platform admin"
        title="Workspaces"
        description="Create a workspace and invite its first owner. Open one for its people, invites, plan label and an audited view."
        meta={`${rows.length.toLocaleString('en-IN')} ${rows.length === 1 ? 'workspace' : 'workspaces'} in ${modeLabel}`}
      />

      <SectionCard
        accent
        title={
          <SectionTitle icon={<Plus />} hue="aura">
            Create a workspace
          </SectionTitle>
        }
        meta={`Created in ${modeLabel} with conservative defaults: no services, prices or sample data; human approval before anything is sent.`}
      >
        <CreateWorkspaceForm mode={mode} />
      </SectionCard>

      <SectionCard
        title={
          <SectionTitle icon={<Building2 />}>All workspaces</SectionTitle>
        }
        meta="Newest first. Counts include only people who can sign in to this installation."
      >
        {rows.length === 0 ? (
          <EmptyState headingLevel="h3" icon={<Building2 />} title="No workspaces yet" description="Create the first workspace above; its owner gets an invite link you send them." />
        ) : (
          <>
            <ScrollRegion label="Workspaces table" wrapperClassName="-mx-4 hidden border-y border-border-subtle md:block sm:-mx-5" className="max-h-[min(80vh,52rem)] overflow-auto scroll-pt-12">
              <table className="w-full min-w-[48rem] text-left text-sm">
                <thead className="text-xs text-fg-2">
                  <tr>
                    {['Workspace', 'Plan', 'Owners', 'Members', 'Employees', 'Invites', 'Created'].map((h, i) => (
                      <th
                        key={h}
                        scope="col"
                        className={cn('sticky top-0 z-10 border-b border-border-subtle bg-bg-1 py-2.5 font-medium', i === 0 ? 'pr-3 pl-4 sm:pl-5' : 'px-3', i >= 3 && i <= 5 && 'text-right', i === 6 && 'pr-4 sm:pr-5')}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {rows.map((w) => (
                    <tr key={w.id} className="transition-colors duration-fast hover:bg-bg-2/60">
                      <td className="py-2.5 pr-3 pl-4 sm:pl-5">
                        <Link href={`/dashboard/admin/workspaces/${w.id}`} className="font-medium text-cyan underline-offset-4 hover:underline">
                          {w.name}
                        </Link>
                        <span className="block font-mono text-xs text-fg-2">{w.slug}</span>
                      </td>
                      <td className="px-3 py-2.5 text-fg-1">{w.planLabel}</td>
                      <td className="px-3 py-2.5">
                        <Owners row={w} />
                      </td>
                      <td className="tabular px-3 py-2.5 text-right text-fg-1">{w.memberCount}</td>
                      <td className="tabular px-3 py-2.5 text-right text-fg-1">{w.activeAssignments}</td>
                      <td className="tabular px-3 py-2.5 text-right text-fg-1">{w.pendingInvites}</td>
                      <td className="tabular py-2.5 pr-4 pl-3 whitespace-nowrap text-fg-2 sm:pr-5">{formatDate(w.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
            <ul aria-label="Workspaces" className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-lg border border-border-subtle bg-bg-0/30 md:hidden">
              {rows.map((w) => (
                <li key={w.id} className="relative flex flex-col gap-1 px-3 py-2.5 transition-colors duration-fast hover:bg-bg-2/60 has-[a:focus-visible]:bg-bg-2/60">
                  <Link href={`/dashboard/admin/workspaces/${w.id}`} className={cn('font-medium text-cyan underline-offset-4 after:absolute after:inset-0 hover:underline', ROW_FOCUS)}>
                    {w.name}
                  </Link>
                  <p className="text-xs text-fg-2">
                    <span className="font-mono">{w.slug}</span> · {w.planLabel} · created {formatDate(w.createdAt)}
                  </p>
                  <p className="flex items-center gap-1.5 text-xs">
                    <Crown aria-hidden="true" className="size-3.5 shrink-0 text-fg-3" />
                    <Owners row={w} />
                  </p>
                  <p className="tabular text-xs text-fg-2">
                    {w.memberCount} members · {w.activeAssignments} employees · {w.pendingInvites} pending invites
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}
      </SectionCard>
    </div>
  );
}
