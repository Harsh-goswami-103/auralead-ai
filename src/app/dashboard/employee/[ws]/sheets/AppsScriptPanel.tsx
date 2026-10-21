'use client';

/**
 * The Apps Script panel of the Google Sheets page (T34, ADR-105; PRD "Generate copyable Apps Script
 * (setup, mapping, event IDs, auth, retry guidance)"). It issues the signing secret (or rotates it
 * behind a confirmation) and shows the secret exactly once, here, with a copy button: the server
 * keeps only an encrypted envelope and can never show it again. The generated script (key id,
 * endpoint, mapping, event-id logic, signing and retries; never the secret) is shown with a copy
 * button and the setup steps. A loopback or plain-http APP_ORIGIN is called out: Apps Script runs
 * on Google's servers. Issuing is LIVE only (a mode gate in DEMO) and needs `sheets.manage`.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert, KeyRound, RefreshCw, TriangleAlert } from 'lucide-react';
import { CopyButton } from '@/components/admin/CopyButton';
import { postJson } from '@/components/patterns/api-client';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format/date';
import { APPS_SCRIPT_ROTATE_CONFIRMATION } from '@/lib/schemas/sheets';

type Issued = { keyId: string; secret: string; rotated: boolean; issuedAt: string };

export function AppsScriptPanel(props: {
  workspaceSlug: string;
  workspaceName: string;
  keyId: string | null;
  secretIssuedAt: string | null;
  endpoint: string;
  originReachable: boolean;
  script: string | null;
  scriptMissingReason: string | null;
  gate: Gate | null;
  timeZone: string;
}) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const [issued, setIssued] = useState<Issued | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function issue(rotate: boolean): Promise<{ ok: true } | { ok: false; message: string; reference: string | null }> {
    setError(null);
    const res = await postJson<Issued>('/api/app/sheets/apps-script/secret', rotate ? { workspaceSlug: props.workspaceSlug, confirm: APPS_SCRIPT_ROTATE_CONFIRMATION } : { workspaceSlug: props.workspaceSlug }, csrf);
    if (!res.ok) {
      setError(`${res.message}${res.reference ? ` Reference ${res.reference}.` : ''}`);
      return { ok: false, message: res.message, reference: res.reference };
    }
    setIssued(res.data);
    router.refresh();
    return { ok: true };
  }

  return (
    <div data-apps-script className="flex flex-col gap-4">
      {!props.originReachable ? (
        <p role="note" className="flex items-start gap-2 rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-sm text-fg-1">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            Apps Script runs on Google’s servers, which cannot reach <span className="font-mono">{props.endpoint}</span>. Set APP_ORIGIN to this app’s public https address before installing the script.
          </span>
        </p>
      ) : null}
      <dl className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <dt className="text-xs text-fg-2">Endpoint</dt>
          <dd className="font-mono text-xs break-all text-fg-1">{props.endpoint}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs text-fg-2">Key id</dt>
          <dd className="font-mono text-sm text-fg-1">{props.keyId ?? <span className="font-sans text-fg-2">Not issued</span>}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs text-fg-2">Signing secret</dt>
          <dd className="text-sm text-fg-1">{props.secretIssuedAt ? `Issued ${formatDateTime(new Date(props.secretIssuedAt), props.timeZone)}; it cannot be shown again` : 'Not issued'}</dd>
        </div>
      </dl>

      {props.keyId === null ? (
        <GatedAction label="Issue signing secret" pendingLabel="Issuing..." variant="secondary" size="sm" icon={<KeyRound aria-hidden="true" />} gate={props.gate} onAction={async () => void (await issue(false))} />
      ) : props.gate ? (
        <GatedAction label="Rotate signing secret" variant="secondary" size="sm" gate={props.gate} />
      ) : (
        <ConfirmDialog
          trigger={
            <Button type="button" variant="secondary" size="sm" className="w-fit">
              <RefreshCw aria-hidden="true" />
              Rotate signing secret
            </Button>
          }
          title="Rotate the Apps Script signing secret?"
          description="A new key id and secret replace the current ones at once. The installed script stops sending until you paste the new script and set the new secret in it; rows it could not send wait in its queue."
          confirmLabel="Rotate secret"
          pendingLabel="Rotating..."
          workspaceName={props.workspaceName}
          destructive
          onConfirm={() => issue(true)}
        />
      )}
      {error ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-fg-1">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
          {error}
        </p>
      ) : null}
      {issued ? (
        <div data-testid="secret-once" className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3">
          <p className="text-sm font-medium text-fg-1">
            {issued.rotated ? 'New signing secret' : 'Signing secret'} for key {issued.keyId}. This is the only time it is shown.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded border border-border-subtle bg-bg-2 px-2 py-1 font-mono text-xs text-fg-1">{issued.secret}</code>
            <CopyButton value={issued.secret} label="signing secret" />
          </div>
          <p className="text-xs text-fg-2">In the Sheet: AuraLead &gt; Set signing secret, paste it. It is kept in Script Properties and never written to a cell. Copy the script below again: it carries the new key id.</p>
        </div>
      ) : null}

      {props.script ? (
        <div className="flex flex-col gap-2">
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-fg-1 marker:text-fg-2">
            <li>In the Sheet with the form responses: Extensions &gt; Apps Script. Replace Code.gs with the script below and save.</li>
            <li>Reload the Sheet, then AuraLead &gt; Set signing secret and paste the secret shown when it was issued.</li>
            <li>AuraLead &gt; Set up: adds the hidden auralead_event_id column, gives every row a stable id and installs the form-submit and retry triggers.</li>
            <li>Existing rows are not pushed: use Sync now below for them. New responses arrive by themselves; failed sends are retried every 15 minutes.</li>
          </ol>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-fg-2">Code.gs (contains no secret)</p>
            <CopyButton value={props.script} label="Apps Script" showText />
          </div>
          <pre className="max-h-96 overflow-auto rounded-lg border border-border-subtle bg-bg-2 p-3 font-mono text-xs leading-relaxed text-fg-1">{props.script}</pre>
        </div>
      ) : (
        <p className="text-sm text-fg-2">{props.scriptMissingReason}</p>
      )}
    </div>
  );
}
