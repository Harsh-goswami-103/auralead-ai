'use client';

/**
 * Per-token actions in the Extension hub (T36): set or clear the allowed Chrome extension id (the
 * only `chrome-extension://` Origin the receiver accepts and answers CORS for with this token), and
 * revoke the token behind a typed confirmation (`REVOKE`). Revocation applies to the bridge's next
 * request, which then gets 401 `token_revoked` and stops. Both re-read the page on success; a
 * failure stays visible with its reference.
 */
import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert, ShieldOff } from 'lucide-react';
import { postJson } from '@/components/patterns/api-client';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { useCsrfToken } from '@/components/patterns/csrf';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CHROME_EXTENSION_ID_RE, EXTENSION_TOKEN_REVOKE_CONFIRMATION } from '@/lib/schemas/webhooks';

export type TokenActionsProps = { workspaceSlug: string; workspaceName: string; tokenId: string; tokenName: string; prefix: string; allowedExtensionId: string | null };

export function TokenActions(props: TokenActionsProps) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const id = useId();
  const [value, setValue] = useState(props.allowedExtensionId ?? '');
  const [message, setMessage] = useState<{ tone: 'danger' | 'success'; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [typed, setTyped] = useState('');

  async function saveAllowed(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const trimmed = value.trim();
    if (trimmed !== '' && !CHROME_EXTENSION_ID_RE.test(trimmed)) {
      setMessage({ tone: 'danger', text: 'A Chrome extension id is 32 letters from a to p.' });
      return;
    }
    setPending(true);
    try {
      const res = await postJson(`/api/app/extension/tokens/${encodeURIComponent(props.tokenId)}/allowed-extension`, { workspaceSlug: props.workspaceSlug, allowedExtensionId: trimmed === '' ? null : trimmed }, csrf);
      if (!res.ok) {
        setMessage({ tone: 'danger', text: `${res.message}${res.reference ? ` (reference ${res.reference})` : ''}` });
        return;
      }
      setMessage({ tone: 'success', text: trimmed === '' ? 'Any extension may use this token now (no CORS answer).' : 'Saved: only this extension may use the token.' });
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function revoke() {
    if (typed.trim() !== EXTENSION_TOKEN_REVOKE_CONFIRMATION) return { ok: false as const, message: `Type ${EXTENSION_TOKEN_REVOKE_CONFIRMATION} to confirm.` };
    const res = await postJson(`/api/app/extension/tokens/${encodeURIComponent(props.tokenId)}/revoke`, { workspaceSlug: props.workspaceSlug, confirm: EXTENSION_TOKEN_REVOKE_CONFIRMATION }, csrf);
    if (!res.ok) return { ok: false as const, message: res.message, reference: res.reference };
    router.refresh();
    return { ok: true as const };
  }

  return (
    <div className="flex flex-col gap-2">
      <form noValidate onSubmit={saveAllowed} aria-label={`Allowed extension id of ${props.tokenName}`} className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Label htmlFor={`${id}-ext`} className="text-xs text-fg-2">
            Allowed extension id
          </Label>
          <Input id={`${id}-ext`} value={value} onChange={(e) => setValue(e.target.value)} className="h-8 font-mono text-xs" placeholder="Any extension" autoComplete="off" spellCheck={false} />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={pending} aria-busy={pending || undefined}>
          Save
        </Button>
        <ConfirmDialog
          trigger={
            <Button type="button" size="sm" variant="outline">
              <ShieldOff aria-hidden="true" />
              Revoke
            </Button>
          }
          title={`Revoke ${props.tokenName}?`}
          description={`The extension using ${props.prefix} is refused from its next request ("Token revoked") and keeps its unsent batches until it gets a new token. This cannot be undone.`}
          confirmLabel="Revoke token"
          pendingLabel="Revoking..."
          workspaceName={props.workspaceName}
          destructive
          onConfirm={revoke}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-confirm`}>Type {EXTENSION_TOKEN_REVOKE_CONFIRMATION} to confirm</Label>
            <Input id={`${id}-confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className="font-mono" />
          </div>
        </ConfirmDialog>
      </form>
      {message ? (
        <p role={message.tone === 'danger' ? 'alert' : 'status'} className={message.tone === 'danger' ? 'flex items-start gap-1 text-xs text-danger' : 'text-xs text-success'}>
          {message.tone === 'danger' ? <CircleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" /> : null}
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
