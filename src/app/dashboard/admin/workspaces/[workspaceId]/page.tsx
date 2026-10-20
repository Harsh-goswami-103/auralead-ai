/**
 * Platform admin: one workspace (T29, R33). Platform metadata first (plan label, time zone,
 * status), then who has access (owners and members, employee assignments), the pending invites
 * (revocable) and a form that invites a client user into this workspace, then the audited
 * drilldown: tenant data only after a typed reason and a sign-in within 15 minutes, through
 * `adminContext`, which records the opening before anything is read. Last, the administrators'
 * own actions on this workspace (drilldowns and access changes), newest first.
 *
 * A workspace of the other mode, or an unknown id, is the not-found page (A6).
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { ArrowLeft, CalendarDays, Eye, Globe2, History, Layers, MailPlus, ShieldCheck, UsersRound } from 'lucide-react';
import { DrilldownLauncher } from '@/components/admin/DrilldownLauncher';
import { InlineEmpty } from '@/components/admin/InlineEmpty';
import { InviteForm } from '@/components/admin/InviteForm';
import { PlanLabelAction, RevokeInviteAction } from '@/components/admin/people-actions';
import { ADMIN_ACTION_LABELS, MEMBERSHIP_ROLE_LABELS, USER_STATUS_VOCABULARY, formatBps } from '@/components/admin/people-vocabulary';
import { SectionTitle } from '@/components/admin/SectionTitle';
import { StatusChip } from '@/components/admin/StatusChip';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { buttonVariants } from '@/components/ui/button';
import type { UserStatus } from '@/lib/domain/enums';
import { NotFoundError } from '@/lib/errors';
import { formatDate, formatDateTime } from '@/lib/format/date';
import { getPageContext } from '@/server/auth/page-context';
import { getWorkspaceAdminView } from '@/server/services/admin/workspaces';

export const metadata: Metadata = { title: 'Workspace' };
export const dynamic = 'force-dynamic';

function Chip(props: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-bg-1/70 px-2.5 py-1 text-xs text-fg-2 [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-panel">
      {props.icon}
      {props.children}
    </span>
  );
}

export default async function AdminWorkspacePage(props: { params: Promise<{ workspaceId: string }> }) {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const { workspaceId } = await props.params;
  let view;
  try {
    view = await getWorkspaceAdminView(page.ctx, workspaceId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { workspace: ws } = view;
  const mode = page.ctx.mode;
  const owners = view.members.filter((m) => m.membershipRole === 'OWNER');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Workspace"
        title={ws.name}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <Chip icon={<Layers aria-hidden="true" />}>{ws.planLabel} plan</Chip>
            <Chip icon={<Globe2 aria-hidden="true" />}>{ws.timezone}</Chip>
            <Chip icon={<CalendarDays aria-hidden="true" />}>Created {formatDate(ws.createdAt)}</Chip>
            <span className="font-mono text-xs text-fg-2">{ws.slug}</span>
          </span>
        }
        actions={
          <>
            <Link href="/dashboard/admin/workspaces" className={buttonVariants({ variant: 'outline' })}>
              <ArrowLeft aria-hidden="true" />
              All workspaces
            </Link>
            <PlanLabelAction mode={mode} workspace={{ id: ws.id, slug: ws.slug, name: ws.name, planLabel: ws.planLabel }} />
          </>
        }
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <SectionCard
          title={<SectionTitle icon={<UsersRound />} hue="aura">People with access</SectionTitle>}
          meta={`${owners.length} ${owners.length === 1 ? 'owner' : 'owners'}, ${view.members.length - owners.length} members, ${view.assignments.filter((a) => a.active).length} active employee assignments`}
        >
          {view.members.length === 0 ? (
            <InlineEmpty icon={<UsersRound />}>No client user has access yet{view.invites.length > 0 ? '; an invite is pending below.' : '. Invite the owner below.'}</InlineEmpty>
          ) : (
            <ul aria-label="Members" className="flex flex-col divide-y divide-border-subtle">
              {view.members.map((m) => {
                const Role = MEMBERSHIP_ROLE_LABELS[m.membershipRole];
                return (
                  <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <div className="flex min-w-0 flex-col">
                      <Link href={`/dashboard/admin/people/${m.id}`} className="font-medium text-cyan underline-offset-4 hover:underline">
                        {m.name}
                      </Link>
                      <span className="text-xs break-all text-fg-2">{m.email}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 text-xs text-fg-1">
                        <Role.icon aria-hidden="true" className="size-3.5 text-fg-3" />
                        {Role.label}
                      </span>
                      <StatusChip entry={USER_STATUS_VOCABULARY[m.status as UserStatus]} state={m.status} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <h3 className="font-display text-sm font-semibold text-fg-1">Employees</h3>
          {view.assignments.length === 0 ? (
            <InlineEmpty icon={<ShieldCheck />}>No employee is assigned. Assign one from their People page.</InlineEmpty>
          ) : (
            <ul aria-label="Employee assignments" className="flex flex-col divide-y divide-border-subtle">
              {view.assignments.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="flex min-w-0 flex-col">
                    <Link href={`/dashboard/admin/people/${a.id}`} className="font-medium text-cyan underline-offset-4 hover:underline">
                      {a.name}
                    </Link>
                    <span className="text-xs break-all text-fg-2">{a.email}</span>
                  </div>
                  <span className="tabular text-xs text-fg-2">
                    {a.active ? 'Active' : 'Inactive'} · {a.capabilityCount} capabilities · cap {a.maxDiscountBps === null ? 'workspace limit' : formatBps(a.maxDiscountBps)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title={<SectionTitle icon={<MailPlus />} hue="aura">Invite a client user</SectionTitle>} meta="Owners hold every capability here; members work leads, drafts, quotations and sends.">
          <InviteForm mode={mode} workspaces={[]} fixedWorkspace={{ id: ws.id, slug: ws.slug, name: ws.name }} />
          <h3 className="font-display text-sm font-semibold text-fg-1">Pending invites</h3>
          {view.invites.length === 0 ? (
            <InlineEmpty icon={<MailPlus />}>No pending invites for this workspace.</InlineEmpty>
          ) : (
            <ul aria-label="Pending invites" className="flex flex-col divide-y divide-border-subtle">
              {view.invites.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="flex min-w-0 flex-col">
                    <span className="text-sm break-all text-fg-1">{i.email}</span>
                    <span className="tabular text-xs text-fg-2">
                      {i.membershipRole ? MEMBERSHIP_ROLE_LABELS[i.membershipRole].label : 'Member'} · expires {formatDateTime(i.expiresAt)}
                      {i.createdBy ? ` · by ${i.createdBy.name}` : ''}
                    </span>
                  </div>
                  <RevokeInviteAction mode={mode} invite={{ id: i.id, email: i.email, workspaceName: ws.name }} />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <SectionCard
        accent
        title={<SectionTitle icon={<Eye />}>Audited view</SectionTitle>}
        meta="Read-only. Needs a reason and a sign-in within 15 minutes; each opening is recorded before anything is read."
      >
        <DrilldownLauncher workspaceId={ws.id} workspaceName={ws.name} mode={mode} />
      </SectionCard>

      <SectionCard title={<SectionTitle icon={<History />} hue="volt">Administrator actions</SectionTitle>} meta="The last ten actions administrators took on this workspace, newest first.">
        {view.adminActions.length === 0 ? (
          <InlineEmpty icon={<History />}>No administrator has acted on this workspace yet.</InlineEmpty>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle">
            {view.adminActions.map((a) => (
              <li key={a.id} className="flex flex-col gap-0.5 py-2.5">
                <span className="text-sm text-fg-1">
                  {ADMIN_ACTION_LABELS[a.action] ?? a.action} <span className="font-mono text-xs text-fg-2">{a.action}</span>
                </span>
                <span className="tabular text-xs text-fg-2">
                  {a.actorName ?? 'An administrator'} · {formatDateTime(a.createdAt)}
                  {a.reason ? ` · “${a.reason}”` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Link href={`/dashboard/admin/audit?workspace=${encodeURIComponent(ws.slug)}`} className="w-fit text-sm font-medium text-cyan underline-offset-4 hover:underline">
          Search this workspace&apos;s full audit history
        </Link>
      </SectionCard>
    </div>
  );
}
