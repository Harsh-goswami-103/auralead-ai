/**
 * Platform admin: one person (T29, R33, R46). Their account (role, status, sign-ins, open reset
 * links) with the role, status and password reset link actions; their workspace access (client
 * memberships, or employee assignments with capabilities and discount cap) with add, change and
 * remove actions; and the last changes made to them (redacted audit rows). Every change needs a
 * reason and a sign-in within 15 minutes, ends the person's sessions and is audited; the server
 * refuses changing yourself, the last administrator or a workspace's last owner. Your own account
 * and, in DEMO, the role-switcher personas show the role and status controls as gated with the
 * reason. A demo account in LIVE, or an unknown id, is the not-found page.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, Building2, History, KeyRound, UserRound } from 'lucide-react';
import { DetailField } from '@/components/admin/DetailField';
import { InlineEmpty } from '@/components/admin/InlineEmpty';
import { AssignmentAction, ChangeRoleAction, MembershipAction, ResetLinkAction, StatusAction } from '@/components/admin/people-actions';
import { ADMIN_ACTION_LABELS, AUDIT_RESULT_VOCABULARY, CAPABILITY_LABELS, MEMBERSHIP_ROLE_LABELS, ROLE_STYLES, USER_STATUS_VOCABULARY, formatBps } from '@/components/admin/people-vocabulary';
import { RoleChip } from '@/components/admin/RoleChip';
import { SectionTitle } from '@/components/admin/SectionTitle';
import { StatusChip } from '@/components/admin/StatusChip';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { buttonVariants } from '@/components/ui/button';
import type { AuditResult } from '@/lib/domain/enums';
import { NotFoundError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format/date';
import { getPageContext } from '@/server/auth/page-context';
import { getPerson } from '@/server/services/admin/people';
import { listWorkspaceOptions } from '@/server/services/admin/workspaces';

export const metadata: Metadata = { title: 'Person' };
export const dynamic = 'force-dynamic';

export default async function AdminPersonPage(props: { params: Promise<{ userId: string }> }) {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const { userId } = await props.params;
  let person;
  try {
    person = await getPerson(page.ctx, userId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const mode = page.ctx.mode;
  const workspaces = await listWorkspaceOptions(page.ctx);
  const ref = { id: person.id, name: person.name };
  const lockGate: Gate | null = person.isSelf
    ? { category: 'permission', reason: 'You cannot change your own role or status. Ask another administrator.' }
    : person.personaLocked
      ? { category: 'mode', reason: 'The DEMO role switcher signs in as this person, so their role and status stay as seeded.' }
      : null;
  const memberOf = new Set(person.memberships.map((m) => m.workspace.id));
  const assignedTo = new Set(person.assignments.map((a) => a.workspace.id));
  const joinable = workspaces.filter((w) => !memberOf.has(w.id));
  const assignable = workspaces.filter((w) => !assignedTo.has(w.id));
  const canReset = person.status === 'ACTIVE';

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Person"
        title={person.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="break-all">{person.email}</span>
            <RoleChip role={person.globalRole} />
            <StatusChip entry={USER_STATUS_VOCABULARY[person.status]} state={person.status} />
          </span>
        }
        actions={
          <Link href="/dashboard/admin/people" className={buttonVariants({ variant: 'outline' })}>
            <ArrowLeft aria-hidden="true" />
            All people
          </Link>
        }
      />

      <SectionCard title={<SectionTitle icon={<UserRound />} hue="aura">Account</SectionTitle>} meta={`Signs in to the ${ROLE_STYLES[person.globalRole].panel}.`}>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <DetailField label="Email" value={person.email} />
          <DetailField label="Joined" value={formatDateTime(person.createdAt)} />
          <DetailField label="Last sign-in" value={person.lastLoginAt ? formatDateTime(person.lastLoginAt) : 'Never'} />
          <DetailField label="Active sessions" value={`${person.activeSessions}${person.lastSeenAt ? `, last seen ${formatDateTime(person.lastSeenAt)}` : ''}`} />
          <DetailField label="Unused reset links" value={String(person.openResetLinks)} />
          <DetailField label="Person id" value={person.id} mono copy={person.id} />
        </dl>
        <div className="flex flex-wrap items-start gap-3 border-t border-border-subtle pt-4">
          {lockGate ? (
            <>
              <GatedAction label="Change role" gate={lockGate} variant="outline" size="sm" />
              <GatedAction label={person.status === 'DISABLED' ? 'Enable account' : 'Disable account'} gate={lockGate} variant="outline" size="sm" />
            </>
          ) : (
            <>
              <ChangeRoleAction mode={mode} person={{ ...ref, globalRole: person.globalRole }} />
              <StatusAction mode={mode} person={{ ...ref, status: person.status }} />
            </>
          )}
        </div>
        {canReset ? (
          <ResetLinkAction mode={mode} person={{ ...ref, email: person.email }} />
        ) : (
          <GatedAction label="Create password reset link" gate={{ category: 'eligibility', reason: 'A disabled account cannot reset its password. Enable it first.' }} variant="outline" size="sm" icon={<KeyRound aria-hidden="true" />} />
        )}
      </SectionCard>

      <SectionCard
        title={<SectionTitle icon={<Building2 />} hue="aura">Workspace access</SectionTitle>}
        meta={
          person.globalRole === 'USER'
            ? 'Client users work in the workspaces they are members of.'
            : person.globalRole === 'EMPLOYEE'
              ? 'Employees work in the workspaces they are assigned to, with exactly the granted capabilities.'
              : 'Super admins hold no memberships; they open workspaces through the audited view.'
        }
      >
        {person.globalRole === 'USER' ? (
          <>
            {person.memberships.length === 0 ? (
              <InlineEmpty icon={<Building2 />}>Not a member of any workspace.</InlineEmpty>
            ) : (
              <ul aria-label="Memberships" className="flex flex-col divide-y divide-border-subtle">
                {person.memberships.map((m) => (
                  <li key={m.workspace.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <div className="flex min-w-0 flex-col">
                      <Link href={`/dashboard/admin/workspaces/${m.workspace.id}`} className="font-medium text-cyan underline-offset-4 hover:underline">
                        {m.workspace.name}
                      </Link>
                      <span className="tabular text-xs text-fg-2">
                        {MEMBERSHIP_ROLE_LABELS[m.membershipRole].label} since {formatDateTime(m.since)}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <MembershipAction mode={mode} person={ref} variant="change" workspace={m.workspace} current={m.membershipRole} />
                      <MembershipAction mode={mode} person={ref} variant="remove" workspace={m.workspace} current={m.membershipRole} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {joinable.length > 0 ? (
              <MembershipAction mode={mode} person={ref} variant="add" workspaces={joinable} />
            ) : (
              <p className="text-xs text-fg-2">{workspaces.length === 0 ? 'No workspace exists yet; create one under Workspaces.' : 'They are a member of every workspace.'}</p>
            )}
          </>
        ) : null}

        {person.globalRole === 'EMPLOYEE' ? (
          <>
            {person.assignments.length === 0 ? (
              <InlineEmpty icon={<Building2 />}>Not assigned to any workspace yet.</InlineEmpty>
            ) : (
              <ul aria-label="Assignments" className="flex flex-col divide-y divide-border-subtle">
                {person.assignments.map((a) => (
                  <li key={a.workspace.id} className="flex flex-col gap-2 py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-col">
                        <Link href={`/dashboard/admin/workspaces/${a.workspace.id}`} className="font-medium text-cyan underline-offset-4 hover:underline">
                          {a.workspace.name}
                        </Link>
                        <span className="tabular text-xs text-fg-2">
                          {a.active ? 'Active' : 'Inactive'} · discount cap {a.maxDiscountBps === null ? 'workspace limit' : formatBps(a.maxDiscountBps)} · since {formatDateTime(a.since)}
                        </span>
                      </div>
                      <AssignmentAction mode={mode} person={ref} variant="edit" workspace={a.workspace} current={{ capabilities: a.capabilities, maxDiscountBps: a.maxDiscountBps, active: a.active }} />
                    </div>
                    <ul aria-label={`Capabilities in ${a.workspace.name}`} className="flex flex-wrap gap-1.5">
                      {a.capabilities.map((c) => (
                        <li key={c} className="rounded-full border border-border-subtle bg-bg-2 px-2 py-0.5 text-xs text-fg-1">
                          {CAPABILITY_LABELS[c].label}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
            {assignable.length > 0 ? (
              <AssignmentAction mode={mode} person={ref} variant="create" workspaces={assignable} />
            ) : (
              <p className="text-xs text-fg-2">{workspaces.length === 0 ? 'No workspace exists yet; create one under Workspaces.' : 'They have an assignment in every workspace; edit one above.'}</p>
            )}
          </>
        ) : null}

        {person.globalRole === 'SUPER_ADMIN' ? (
          <InlineEmpty icon={<Building2 />}>Super admins open workspaces only through the audited view on each workspace page.</InlineEmpty>
        ) : null}
      </SectionCard>

      <SectionCard title={<SectionTitle icon={<History />} hue="volt">Recent changes</SectionTitle>} meta="The last twenty changes made to this person, newest first.">
        {person.activity.length === 0 ? (
          <InlineEmpty icon={<History />}>No changes recorded yet.</InlineEmpty>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle">
            {person.activity.map((a) => (
              <li key={a.id} className="flex flex-col gap-1 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm text-fg-1">
                    {ADMIN_ACTION_LABELS[a.action] ?? a.action} <span className="font-mono text-xs text-fg-2">{a.action}</span>
                  </span>
                  <StatusChip entry={AUDIT_RESULT_VOCABULARY[a.result as AuditResult]} state={a.result} />
                </div>
                <span className="tabular text-xs text-fg-2">
                  {formatDateTime(a.createdAt)}
                  {a.workspace ? ` · ${a.workspace.name}` : ''}
                  {a.reason ? ` · “${a.reason}”` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Link href={`/dashboard/admin/audit?targetId=${encodeURIComponent(person.id)}`} className="w-fit text-sm font-medium text-cyan underline-offset-4 hover:underline">
          Search the audit history for this person
        </Link>
      </SectionCard>
    </div>
  );
}
