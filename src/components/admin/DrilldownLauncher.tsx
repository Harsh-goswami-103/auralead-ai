'use client';

/**
 * DrilldownLauncher (T29): opens the audited, read-only view of a workspace. Opening needs a typed
 * reason and a sign-in within 15 minutes; the server writes the `admin.elevate` audit row before
 * it reads anything (plan §4.1), so the request is a POST (CSRF-checked, never triggered by a link
 * or a prefetch). A refusal shows the server's message; a stale sign-in is renewed in place. The
 * view lives only in this page's memory: closing it or leaving the page drops it.
 */
import { useId, useState } from 'react';
import { Eye, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ADMIN_REASON_MAX, ADMIN_REASON_MIN } from '@/lib/schemas/admin-people';
import { DrilldownView, type DrilldownData } from './DrilldownView';
import { ReauthPanel, useAdminPost, type AdminMode } from './use-admin-post';

export function DrilldownLauncher(props: { workspaceId: string; workspaceName: string; mode: AdminMode }) {
  const api = useAdminPost(props.mode);
  const id = useId();
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; reference: string | null } | null>(null);
  const [data, setData] = useState<DrilldownData | null>(null);
  const tooShort = reason.trim().length < ADMIN_REASON_MIN;

  async function openView() {
    if (tooShort) {
      setError({ message: `Give a reason of at least ${ADMIN_REASON_MIN} characters.`, reference: null });
      return;
    }
    setPending(true);
    setError(null);
    const result = await api.send<DrilldownData>(`/api/admin/workspaces/${encodeURIComponent(props.workspaceId)}/drilldown`, { reason: reason.trim() });
    setPending(false);
    if (result.ok) {
      setData(result.data);
      setReason('');
      return;
    }
    if (result.code === 'REAUTH_REQUIRED') setError({ message: 'Confirm your identity below, then open the view again.', reference: null });
    else setError({ message: result.message, reference: result.reference });
  }

  if (data) return <DrilldownView data={data} onClose={() => setData(null)} />;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg-2">
        Shows {props.workspaceName}&apos;s configuration and counts (leads by stage, quotations by status, integrations, jobs) without names, contacts or messages. Each opening is
        recorded on the audit log with your reason, before anything is read.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-reason`}>Reason for opening (stored on the audit record)</Label>
        <Textarea
          id={`${id}-reason`}
          rows={2}
          value={reason}
          maxLength={ADMIN_REASON_MAX}
          aria-describedby={`${id}-help`}
          aria-invalid={(error !== null && tooShort) || undefined}
          onChange={(e) => setReason(e.target.value)}
        />
        <p id={`${id}-help`} className="text-xs text-fg-2">
          At least {ADMIN_REASON_MIN} characters, for example a support ticket number.
        </p>
      </div>
      {api.needsReauth ? <ReauthPanel mode={props.mode} reauthing={api.reauthing} error={api.reauthError} onReauth={api.reauthenticate} /> : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error.message}
          {error.reference ? <span className="block text-xs text-fg-2">Reference: {error.reference}</span> : null}
        </p>
      ) : null}
      <Button type="button" className="w-fit" aria-busy={pending || undefined} disabled={pending} onClick={() => void openView()}>
        {pending ? <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" /> : <Eye aria-hidden="true" />}
        {pending ? 'Opening...' : 'Open audited view'}
      </Button>
    </div>
  );
}
