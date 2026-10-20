'use client';

/**
 * InviteForm (T29): creates a single-use invite and shows its link once. On People it invites a
 * client user into a chosen workspace (as owner or member), an employee or a super admin; on a
 * workspace page it invites a client user into that workspace. The address must not have an
 * account yet (the server answers EMAIL_IN_USE; existing people get access on their People page).
 * Needs a reason and a sign-in within 15 minutes (renewed in place). Native form: Enter submits.
 */
import { useId, useState, type FormEvent } from 'react';
import { LoaderCircle, Send } from 'lucide-react';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import type { GlobalRole, MembershipRole } from '@/lib/domain/enums';
import { ADMIN_REASON_MAX, ADMIN_REASON_MIN } from '@/lib/schemas/admin-people';
import { OneTimeLink, type OneTimeLinkValue } from './OneTimeLink';
import { MEMBERSHIP_ROLE_LABELS, ROLE_STYLES } from './people-vocabulary';
import { ReauthPanel, useAdminPost, type AdminMode } from './use-admin-post';

type WorkspaceOption = { id: string; slug: string; name: string };

const KINDS: readonly GlobalRole[] = ['USER', 'EMPLOYEE', 'SUPER_ADMIN'];
const KIND_HINT: Readonly<Record<GlobalRole, string>> = {
  USER: 'Joins the chosen workspace in the Client panel.',
  EMPLOYEE: 'Joins the Operator panel; assign workspaces on their People page after they accept.',
  SUPER_ADMIN: 'Gets full platform administration, like you.',
};

export function InviteForm(props: { mode: AdminMode; workspaces: WorkspaceOption[]; fixedWorkspace?: WorkspaceOption }) {
  const id = useId();
  const router = useRouter();
  const api = useAdminPost(props.mode);
  const fixed = props.fixedWorkspace;
  const [email, setEmail] = useState('');
  const [kind, setKind] = useState<GlobalRole>('USER');
  const [workspaceId, setWorkspaceId] = useState(fixed?.id ?? props.workspaces[0]?.id ?? '');
  const [membershipRole, setMembershipRole] = useState<MembershipRole>('MEMBER');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; reference: string | null } | null>(null);
  const [issued, setIssued] = useState<OneTimeLinkValue | null>(null);
  const client = kind === 'USER';
  const noWorkspace = client && !fixed && props.workspaces.length === 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (reason.trim().length < ADMIN_REASON_MIN) return setError({ message: `Give a reason of at least ${ADMIN_REASON_MIN} characters.`, reference: null });
    if (client && !workspaceId) return setError({ message: 'Create a workspace first, then invite its people.', reference: null });
    setPending(true);
    const body = client ? { email, globalRole: kind, targetWorkspaceId: workspaceId, membershipRole, reason: reason.trim() } : { email, globalRole: kind, reason: reason.trim() };
    const result = await api.send<{ link: string; invite: { email: string; expiresAt: string }; supersededInvites: number }>('/api/admin/people/invites', body);
    setPending(false);
    if (!result.ok) {
      setError(result.code === 'REAUTH_REQUIRED' ? { message: 'Confirm your identity below, then create the invite again.', reference: null } : { message: result.message, reference: result.reference });
      return;
    }
    setIssued({ kind: 'invite', link: result.data.link, expiresAt: result.data.invite.expiresAt, email: result.data.invite.email });
    if (result.data.supersededInvites > 0) toast.info('The earlier pending invite to this address no longer works.');
    setEmail('');
    setReason('');
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <form noValidate onSubmit={(e) => void submit(e)} className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-email`}>Email address</Label>
          <Input id={`${id}-email`} type="email" autoComplete="off" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        {fixed ? null : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-kind`}>Invite as</Label>
            <NativeSelect id={`${id}-kind`} value={kind} aria-describedby={`${id}-kind-hint`} onChange={(e) => setKind(e.target.value as GlobalRole)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {ROLE_STYLES[k].label}
                </option>
              ))}
            </NativeSelect>
            <span id={`${id}-kind-hint`} className="text-xs text-fg-2">
              {KIND_HINT[kind]}
            </span>
          </div>
        )}
        {client && !fixed ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-ws`}>Workspace</Label>
            <NativeSelect id={`${id}-ws`} value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
              {props.workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.slug})
                </option>
              ))}
            </NativeSelect>
            {noWorkspace ? <span className="text-xs text-fg-2">No workspace exists yet. Create one under Workspaces first.</span> : null}
          </div>
        ) : null}
        {client ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-mrole`}>Role in the workspace</Label>
            <NativeSelect id={`${id}-mrole`} value={membershipRole} onChange={(e) => setMembershipRole(e.target.value as MembershipRole)}>
              {(['OWNER', 'MEMBER'] as const).map((r) => (
                <option key={r} value={r}>
                  {MEMBERSHIP_ROLE_LABELS[r].label}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5 md:col-span-2">
          <Label htmlFor={`${id}-reason`}>Reason (stored on the audit record)</Label>
          <Textarea id={`${id}-reason`} rows={2} maxLength={ADMIN_REASON_MAX} value={reason} aria-describedby={`${id}-reason-help`} onChange={(e) => setReason(e.target.value)} />
          <span id={`${id}-reason-help`} className="text-xs text-fg-2">
            At least {ADMIN_REASON_MIN} characters.
          </span>
        </div>
        {api.needsReauth ? (
          <div className="md:col-span-2">
            <ReauthPanel mode={props.mode} reauthing={api.reauthing} error={api.reauthError} onReauth={api.reauthenticate} />
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger md:col-span-2">
            {error.message}
            {error.reference ? <span className="block text-xs text-fg-2">Reference: {error.reference}</span> : null}
          </p>
        ) : null}
        <div className="md:col-span-2">
          <Button type="submit" aria-busy={pending || undefined} disabled={pending}>
            {pending ? <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" /> : <Send aria-hidden="true" />}
            {pending ? 'Creating...' : 'Create invite link'}
          </Button>
        </div>
      </form>
      {issued ? <OneTimeLink value={issued} label="Invite link" onDone={() => setIssued(null)} /> : null}
    </div>
  );
}
