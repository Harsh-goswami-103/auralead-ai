'use client';

/**
 * The super admin's access actions (T29), each one AdminFormDialog against its /api/admin route:
 * role, status, password reset link (shown once), membership (add, change, remove), employee
 * assignment (create, edit, deactivate), invite revocation and plan label. The server re-checks
 * every rule (self, last administrator, last owner, demo users in LIVE) and answers with a
 * message the dialog shows; these controls only collect the input.
 */
import { useId, useState } from 'react';
import { Ban, Building2, KeyRound, Pencil, Play, Plus, Tag, Trash2, UserCog, XCircle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import type { Capability, GlobalRole, MembershipRole } from '@/lib/domain/enums';
import { PLAN_LABEL_MAX } from '@/lib/schemas/admin-people';
import { AdminFormDialog } from './AdminFormDialog';
import { CapabilityPicker } from './CapabilityPicker';
import { OneTimeLink, type OneTimeLinkValue } from './OneTimeLink';
import { MEMBERSHIP_ROLE_LABELS, ROLE_STYLES } from './people-vocabulary';
import type { AdminMode } from './use-admin-post';

type Person = { id: string; name: string };
type WorkspaceOption = { id: string; slug: string; name: string };

const ICON = { 'aria-hidden': true } as const;
const peopleUrl = (userId: string, action: string) => `/api/admin/people/${encodeURIComponent(userId)}/${action}`;

export function ChangeRoleAction(props: { mode: AdminMode; person: Person & { globalRole: GlobalRole } }) {
  const id = useId();
  const others = (Object.keys(ROLE_STYLES) as GlobalRole[]).filter((r) => r !== props.person.globalRole);
  const [role, setRole] = useState<GlobalRole>(others[0]!);
  return (
    <AdminFormDialog
      mode={props.mode}
      triggerLabel="Change role"
      triggerIcon={<UserCog {...ICON} />}
      title={`Change ${props.person.name}'s role`}
      description="Every session of theirs ends now; they sign in again with the new role. A person who still holds workspace access keeps their role until that access is removed."
      confirmLabel="Change role"
      endpoint={peopleUrl(props.person.id, 'role')}
      onOpen={() => setRole(others[0]!)}
      body={() => ({ globalRole: role })}
      successMessage={(d) => ((d as { changed?: boolean }).changed ? `Role changed to ${ROLE_STYLES[role].label}. Their sessions were ended.` : 'The role was already set.')}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-role`}>New role</Label>
        <NativeSelect id={`${id}-role`} value={role} onChange={(e) => setRole(e.target.value as GlobalRole)}>
          {others.map((r) => (
            <option key={r} value={r}>
              {ROLE_STYLES[r].label} ({ROLE_STYLES[r].panel})
            </option>
          ))}
        </NativeSelect>
      </div>
    </AdminFormDialog>
  );
}

export function StatusAction(props: { mode: AdminMode; person: Person & { status: string } }) {
  const disabling = props.person.status !== 'DISABLED';
  return (
    <AdminFormDialog
      mode={props.mode}
      destructive={disabling}
      triggerLabel={disabling ? 'Disable account' : 'Enable account'}
      triggerIcon={disabling ? <Ban {...ICON} /> : <Play {...ICON} />}
      title={disabling ? `Disable ${props.person.name}` : `Enable ${props.person.name}`}
      description={
        disabling
          ? 'They are signed out everywhere now and cannot sign in or use a reset link until an administrator enables the account again. Their memberships and assignments stay.'
          : 'They can sign in again with their password (or a reset link you create).'
      }
      confirmLabel={disabling ? 'Disable account' : 'Enable account'}
      endpoint={peopleUrl(props.person.id, 'status')}
      body={() => ({ status: disabling ? 'DISABLED' : 'ACTIVE' })}
      successMessage={() => (disabling ? 'Account disabled. Every session was ended.' : 'Account enabled.')}
    />
  );
}

export function ResetLinkAction(props: { mode: AdminMode; person: Person & { email: string } }) {
  const [issued, setIssued] = useState<OneTimeLinkValue | null>(null);
  return (
    <div className="flex flex-col items-start gap-3">
      <AdminFormDialog
        mode={props.mode}
        triggerLabel="Create password reset link"
        triggerIcon={<KeyRound {...ICON} />}
        title={`Password reset link for ${props.person.name}`}
        description="Creates a single-use link valid for one hour and ends any earlier unused link. Redeeming it sets a new password and ends every session of theirs. You send the link yourself."
        confirmLabel="Create link"
        endpoint={peopleUrl(props.person.id, 'reset-link')}
        body={() => ({})}
        successMessage={() => null}
        onSuccess={(d) => {
          const data = d as { link: string; expiresAt: string; email: string };
          setIssued({ kind: 'reset', link: data.link, expiresAt: data.expiresAt, email: data.email });
        }}
      />
      {issued ? <OneTimeLink value={issued} label="Password reset link" onDone={() => setIssued(null)} /> : null}
    </div>
  );
}

/** Add a client user to a workspace, or change / remove an existing membership. */
export function MembershipAction(
  props: { mode: AdminMode; person: Person } & (
    | { variant: 'add'; workspaces: WorkspaceOption[] }
    | { variant: 'change'; workspace: WorkspaceOption; current: MembershipRole }
    | { variant: 'remove'; workspace: WorkspaceOption; current: MembershipRole }
  ),
) {
  const id = useId();
  const firstWorkspace = props.variant === 'add' ? (props.workspaces[0]?.id ?? '') : props.workspace.id;
  const [workspaceId, setWorkspaceId] = useState(firstWorkspace);
  const initialRole: MembershipRole = props.variant === 'add' ? 'MEMBER' : props.current === 'OWNER' ? 'MEMBER' : 'OWNER';
  const [role, setRole] = useState<MembershipRole>(initialRole);
  const url = peopleUrl(props.person.id, 'memberships');

  if (props.variant === 'remove') {
    return (
      <AdminFormDialog
        mode={props.mode}
        destructive
        triggerLabel="Remove"
        triggerIcon={<Trash2 {...ICON} />}
        title={`Remove ${props.person.name} from ${props.workspace.name}`}
        description="They lose access to this workspace now and every session of theirs ends. A workspace's last active owner cannot be removed."
        workspaceName={props.workspace.name}
        confirmLabel="Remove access"
        endpoint={url}
        body={() => ({ targetWorkspaceId: props.workspace.id, membershipRole: null })}
        successMessage={() => `Removed from ${props.workspace.name}.`}
      />
    );
  }

  const isAdd = props.variant === 'add';
  const workspaceName = isAdd ? undefined : props.workspace.name;
  return (
    <AdminFormDialog
      mode={props.mode}
      triggerLabel={isAdd ? 'Add to a workspace' : 'Change workspace role'}
      triggerIcon={isAdd ? <Plus {...ICON} /> : <Pencil {...ICON} />}
      title={isAdd ? `Add ${props.person.name} to a workspace` : `Change ${props.person.name}'s role in ${props.workspace.name}`}
      description="Owners hold every capability in their workspace; members work leads, drafts, quotations and sends. Every session of theirs ends so the change applies at once."
      workspaceName={workspaceName}
      confirmLabel={isAdd ? 'Grant access' : 'Change role'}
      endpoint={url}
      onOpen={() => {
        setWorkspaceId(firstWorkspace);
        setRole(initialRole);
      }}
      body={() => (workspaceId ? { targetWorkspaceId: workspaceId, membershipRole: role } : 'Choose a workspace.')}
      successMessage={() => (isAdd ? 'Access granted. Their sessions were ended.' : 'Workspace role changed.')}
    >
      {isAdd ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-ws`}>Workspace</Label>
          <NativeSelect id={`${id}-ws`} value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
            {props.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.slug})
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-role`}>Role in the workspace</Label>
        <NativeSelect id={`${id}-role`} value={role} onChange={(e) => setRole(e.target.value as MembershipRole)}>
          {(['OWNER', 'MEMBER'] as const).map((r) => (
            <option key={r} value={r}>
              {MEMBERSHIP_ROLE_LABELS[r].label}
            </option>
          ))}
        </NativeSelect>
      </div>
    </AdminFormDialog>
  );
}

const parseCap = (text: string): number | null | 'invalid' => {
  const t = text.trim();
  if (t === '') return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return 'invalid';
  const bps = Math.round(Number(t) * 100);
  return bps > 10_000 ? 'invalid' : bps;
};

/** Assign an employee to a workspace, or edit an assignment (capabilities, own discount cap, active). */
export function AssignmentAction(
  props: { mode: AdminMode; person: Person } & (
    | { variant: 'create'; workspaces: WorkspaceOption[] }
    | { variant: 'edit'; workspace: WorkspaceOption; current: { capabilities: Capability[]; maxDiscountBps: number | null; active: boolean } }
  ),
) {
  const id = useId();
  const isCreate = props.variant === 'create';
  const initial = isCreate
    ? { workspaceId: props.workspaces[0]?.id ?? '', capabilities: ['leads.read'] as Capability[], cap: '', active: true }
    : {
        workspaceId: props.workspace.id,
        capabilities: props.current.capabilities,
        cap: props.current.maxDiscountBps === null ? '' : String(props.current.maxDiscountBps / 100),
        active: props.current.active,
      };
  const [workspaceId, setWorkspaceId] = useState(initial.workspaceId);
  const [capabilities, setCapabilities] = useState<Capability[]>(initial.capabilities);
  const [cap, setCap] = useState(initial.cap);
  const [active, setActive] = useState(initial.active);

  return (
    <AdminFormDialog
      mode={props.mode}
      triggerLabel={isCreate ? 'Assign to a workspace' : 'Edit assignment'}
      triggerIcon={isCreate ? <Building2 {...ICON} /> : <Pencil {...ICON} />}
      title={isCreate ? `Assign ${props.person.name} to a workspace` : `Edit ${props.person.name}'s assignment in ${props.workspace.name}`}
      description="The employee works in the workspace with exactly these capabilities. Their discount cap applies on top of the workspace limit (the lower one wins). Every session of theirs ends so the change applies at once."
      workspaceName={isCreate ? undefined : props.workspace.name}
      confirmLabel={isCreate ? 'Assign' : 'Save assignment'}
      endpoint={peopleUrl(props.person.id, 'assignments')}
      onOpen={() => {
        setWorkspaceId(initial.workspaceId);
        setCapabilities(initial.capabilities);
        setCap(initial.cap);
        setActive(initial.active);
      }}
      body={() => {
        if (!workspaceId) return 'Choose a workspace.';
        const parsed = parseCap(cap);
        if (parsed === 'invalid') return 'Enter the discount cap as a percentage from 0 to 100, or leave it empty.';
        if (active && capabilities.length === 0) return 'Grant at least one capability, or untick Active.';
        return { targetWorkspaceId: workspaceId, capabilities, maxDiscountBps: parsed, active };
      }}
      successMessage={() => 'Assignment saved. Their sessions were ended.'}
    >
      {isCreate ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-ws`}>Workspace</Label>
          <NativeSelect id={`${id}-ws`} value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
            {props.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.slug})
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : null}
      <CapabilityPicker value={capabilities} onChange={setCapabilities} />
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-cap`}>Own discount cap (%)</Label>
          <Input id={`${id}-cap`} inputMode="decimal" className="w-32" value={cap} placeholder="Workspace limit" aria-describedby={`${id}-cap-hint`} onChange={(e) => setCap(e.target.value)} />
          <span id={`${id}-cap-hint`} className="text-xs text-fg-2">
            Empty: the workspace limit applies.
          </span>
        </div>
        <label className="flex items-center gap-2 pb-6 text-sm text-fg-1">
          <input type="checkbox" className="size-4 accent-aura" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active
        </label>
      </div>
    </AdminFormDialog>
  );
}

export function RevokeInviteAction(props: { mode: AdminMode; invite: { id: string; email: string; workspaceName: string | null } }) {
  return (
    <AdminFormDialog
      mode={props.mode}
      destructive
      triggerLabel="Revoke"
      triggerIcon={<XCircle {...ICON} />}
      title={`Revoke the invite for ${props.invite.email}`}
      description="The link stops working now. You can invite the same address again later."
      workspaceName={props.invite.workspaceName ?? undefined}
      confirmLabel="Revoke invite"
      endpoint={`/api/admin/people/invites/${encodeURIComponent(props.invite.id)}/revoke`}
      body={() => ({})}
      successMessage={() => 'Invite revoked.'}
    />
  );
}

export function PlanLabelAction(props: { mode: AdminMode; workspace: WorkspaceOption & { planLabel: string } }) {
  const id = useId();
  const [label, setLabel] = useState(props.workspace.planLabel);
  return (
    <AdminFormDialog
      mode={props.mode}
      triggerLabel="Change plan label"
      triggerIcon={<Tag {...ICON} />}
      title={`Change the plan label of ${props.workspace.name}`}
      description="The plan label is shown to the workspace and on the admin pages. It is a label only: nothing is billed and no feature changes."
      workspaceName={props.workspace.name}
      confirmLabel="Save label"
      endpoint={`/api/admin/workspaces/${encodeURIComponent(props.workspace.id)}/plan-label`}
      onOpen={() => setLabel(props.workspace.planLabel)}
      body={() => (label.trim().length === 0 ? 'Enter a plan label.' : { planLabel: label.trim() })}
      successMessage={(d) => ((d as { changed?: boolean }).changed ? `Plan label set to ${label.trim()}.` : 'The plan label was already set.')}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-label`}>Plan label</Label>
        <Input id={`${id}-label`} value={label} maxLength={PLAN_LABEL_MAX} onChange={(e) => setLabel(e.target.value)} />
      </div>
    </AdminFormDialog>
  );
}
