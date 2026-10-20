/**
 * Platform admin: people (T29, R33, R46). Everyone who can sign in to this installation, with
 * role, status, last sign-in and workspace access; an invite form (client user into a workspace,
 * employee, super admin) whose link is shown once; and the pending invites, revocable. Rows open
 * the person's page, where role, status, access and password reset links are changed. In LIVE no
 * demo account is listed.
 *
 * Look (design spec §6): PageHeader, the invite form in an accent SectionCard, a GET search form
 * (text, role, status), then a neutral table with role chips in their panel hues and status chips
 * with icon + label, which becomes a divided list on phones; Newest/Older paging.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronLeft, ChevronRight, MailPlus, Users } from 'lucide-react';
import { InlineEmpty } from '@/components/admin/InlineEmpty';
import { InviteForm } from '@/components/admin/InviteForm';
import { RevokeInviteAction } from '@/components/admin/people-actions';
import { MEMBERSHIP_ROLE_LABELS, ROLE_STYLES, USER_STATUS_VOCABULARY } from '@/components/admin/people-vocabulary';
import { RoleChip } from '@/components/admin/RoleChip';
import { ScrollRegion } from '@/components/admin/ScrollRegion';
import { SearchForm } from '@/components/admin/SearchForm';
import { SectionTitle } from '@/components/admin/SectionTitle';
import { StatusChip } from '@/components/admin/StatusChip';
import { EmptyState } from '@/components/patterns/EmptyState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { GlobalRole, UserStatus } from '@/lib/domain/enums';
import { formatDateTime } from '@/lib/format/date';
import { getPageContext } from '@/server/auth/page-context';
import { listPendingInvites, listPeople, type PersonRow } from '@/server/services/admin/people';
import { listWorkspaceOptions } from '@/server/services/admin/workspaces';

export const metadata: Metadata = { title: 'People' };
export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined);
const ROW_FOCUS = 'focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-aura';

function Access({ person }: { person: PersonRow }) {
  if (person.globalRole === 'SUPER_ADMIN') return <span className="text-fg-2">All workspaces (audited)</span>;
  if (person.globalRole === 'USER') {
    if (person.memberships.length === 0) return <span className="text-fg-2">No workspace</span>;
    return <span className="text-fg-1">{person.memberships.map((m) => `${m.workspace.name} (${MEMBERSHIP_ROLE_LABELS[m.membershipRole].label.toLowerCase()})`).join(', ')}</span>;
  }
  const active = person.assignments.filter((a) => a.active);
  if (active.length === 0) return <span className="text-fg-2">No active assignment</span>;
  return <span className="text-fg-1">{active.map((a) => `${a.workspace.name} (${a.capabilityCount} capabilities)`).join(', ')}</span>;
}

export default async function AdminPeoplePage(props: { searchParams: Promise<Search> }) {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const search = await props.searchParams;
  const q = one(search.q);
  const globalRole = GlobalRole.find((r) => r === one(search.globalRole));
  const status = UserStatus.find((s) => s === one(search.status));
  const before = one(search.before);
  const ctx = page.ctx;
  const mode = ctx.mode;

  const [list, invites, workspaces] = await Promise.all([listPeople(ctx, { q, globalRole, status, before }), listPendingInvites(ctx, {}), listWorkspaceOptions(ctx)]);
  const filtered = Boolean(q || globalRole || status);
  const href = (extra: Record<string, string | undefined>) => {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries({ q, globalRole, status, ...extra })) if (v) query.set(k, v);
    const s = query.toString();
    return `/dashboard/admin/people${s ? `?${s}` : ''}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Platform admin"
        title="People"
        description="Who can sign in, with which role and access. Every change ends that person's sessions and is audited with your reason."
        meta={`${mode === 'live' ? 'LIVE' : 'DEMO'} installation`}
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <SectionCard accent title={<SectionTitle icon={<MailPlus />} hue="aura">Invite someone</SectionTitle>} meta="Single-use link, valid 72 hours, shown once for you to send.">
          <InviteForm mode={mode} workspaces={workspaces} />
        </SectionCard>
        <SectionCard title={<SectionTitle icon={<MailPlus />}>Pending invites</SectionTitle>} meta={`${invites.length} waiting to be accepted`}>
          {invites.length === 0 ? (
            <InlineEmpty icon={<MailPlus />}>No pending invites.</InlineEmpty>
          ) : (
            <ul aria-label="Pending invites" className="flex flex-col divide-y divide-border-subtle">
              {invites.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm break-all text-fg-1">{i.email}</span>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-fg-2">
                      <RoleChip role={i.globalRole} />
                      {i.workspace ? `${i.workspace.name} (${i.membershipRole ? MEMBERSHIP_ROLE_LABELS[i.membershipRole].label.toLowerCase() : 'member'})` : null}
                    </span>
                    <span className="tabular text-xs text-fg-2">
                      Expires {formatDateTime(i.expiresAt)}
                      {i.byOperator ? ' · from the server (admin:bootstrap)' : i.createdBy ? ` · by ${i.createdBy.name}` : ''}
                    </span>
                  </div>
                  <RevokeInviteAction mode={mode} invite={{ id: i.id, email: i.email, workspaceName: i.workspace?.name ?? null }} />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <SectionCard title={<SectionTitle icon={<Users />}>Everyone</SectionTitle>} meta={`Newest first${filtered ? ', filtered' : ''}; ${list.rows.length} shown${before ? ' from an older page' : ''}.`}>
        <SearchForm
          idPrefix="people"
          clearHref={filtered ? '/dashboard/admin/people' : null}
          fields={[
            { kind: 'text', name: 'q', label: 'Name or email', value: q ?? '', placeholder: 'asha@ or Asha' },
            { kind: 'select', name: 'globalRole', label: 'Role', value: globalRole ?? '', options: GlobalRole.map((r) => ({ value: r, label: ROLE_STYLES[r].label })) },
            { kind: 'select', name: 'status', label: 'Status', value: status ?? '', options: UserStatus.map((s) => ({ value: s, label: USER_STATUS_VOCABULARY[s].label })) },
          ]}
        />
        {list.rows.length === 0 ? (
          <EmptyState
            headingLevel="h3"
            icon={<Users />}
            title={filtered ? 'Nobody matches these filters' : 'Nobody here yet'}
            description={filtered ? 'Try another name, role or status, or clear the filters.' : 'Invite the first people above.'}
            action={
              filtered ? (
                <Button asChild variant="secondary">
                  <Link href="/dashboard/admin/people">Clear filters</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <ScrollRegion label="People table" wrapperClassName="-mx-4 hidden border-y border-border-subtle md:block sm:-mx-5" className="max-h-[min(80vh,52rem)] overflow-auto scroll-pt-12">
              <table className="w-full min-w-[52rem] text-left text-sm">
                <thead className="text-xs text-fg-2">
                  <tr>
                    {['Person', 'Role', 'Status', 'Access', 'Last sign-in'].map((h, i) => (
                      <th key={h} scope="col" className={cn('sticky top-0 z-10 border-b border-border-subtle bg-bg-1 py-2.5 font-medium', i === 0 ? 'pr-3 pl-4 sm:pl-5' : i === 4 ? 'pr-4 pl-3 sm:pr-5' : 'px-3')}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {list.rows.map((p) => (
                    <tr key={p.id} className="transition-colors duration-fast hover:bg-bg-2/60">
                      <td className="py-2.5 pr-3 pl-4 sm:pl-5">
                        <Link href={`/dashboard/admin/people/${p.id}`} className="font-medium text-cyan underline-offset-4 hover:underline">
                          {p.name}
                        </Link>
                        <span className="block text-xs break-all text-fg-2">{p.email}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <RoleChip role={p.globalRole} />
                      </td>
                      <td className="px-3 py-2.5">
                        <StatusChip entry={USER_STATUS_VOCABULARY[p.status]} state={p.status} />
                      </td>
                      <td className="max-w-80 px-3 py-2.5 text-xs">
                        <Access person={p} />
                      </td>
                      <td className="tabular py-2.5 pr-4 pl-3 whitespace-nowrap text-fg-2 sm:pr-5">{p.lastLoginAt ? formatDateTime(p.lastLoginAt) : 'Never'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
            <ul aria-label="People" className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-lg border border-border-subtle bg-bg-0/30 md:hidden">
              {list.rows.map((p) => (
                <li key={p.id} className="relative flex flex-col gap-1 px-3 py-2.5 transition-colors duration-fast hover:bg-bg-2/60 has-[a:focus-visible]:bg-bg-2/60">
                  <div className="flex items-start justify-between gap-2">
                    <Link href={`/dashboard/admin/people/${p.id}`} className={cn('min-w-0 font-medium text-cyan underline-offset-4 after:absolute after:inset-0 hover:underline', ROW_FOCUS)}>
                      {p.name}
                    </Link>
                    <StatusChip entry={USER_STATUS_VOCABULARY[p.status]} state={p.status} />
                  </div>
                  <span className="text-xs break-all text-fg-2">{p.email}</span>
                  <span className="flex flex-wrap items-center gap-1.5 text-xs">
                    <RoleChip role={p.globalRole} />
                    <Access person={p} />
                  </span>
                  <span className="tabular text-xs text-fg-2">Last sign-in {p.lastLoginAt ? formatDateTime(p.lastLoginAt) : 'never'}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {list.nextCursor || before ? (
          <nav aria-label="People pages" className="flex flex-wrap items-center gap-2">
            {before ? (
              <Button asChild variant="outline" size="sm">
                <Link href={href({})}>
                  <ChevronLeft aria-hidden="true" />
                  Newest
                </Link>
              </Button>
            ) : null}
            {list.nextCursor ? (
              <Button asChild variant="outline" size="sm">
                <Link href={href({ before: list.nextCursor })}>
                  Older
                  <ChevronRight aria-hidden="true" />
                </Link>
              </Button>
            ) : null}
          </nav>
        ) : null}
      </SectionCard>
    </div>
  );
}
