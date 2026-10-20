'use client';

/**
 * Super admin actions (T24): job cancel and retry, AMBIGUOUS resolution, and the global outbound
 * pause. Each opens a confirmation that asks for a typed reason (stored on the audit row) and, for
 * a resend, the confirm text RESEND. The server re-checks everything.
 *
 * These actions need a fresh authentication (within 15 minutes). When the server answers
 * REAUTH_REQUIRED, the dialog asks for it in place: the password in LIVE, a fresh persona sign-in
 * in DEMO (the seeded personas have no password). The new session's CSRF token is used for the
 * retry, and the page refreshes after success.
 *
 * Every opening starts clean (reason, typed confirmation and the reauth panel reset when the
 * trigger opens the dialog). The reason field states its length rule up front, counts characters,
 * and is marked invalid (with the rule tied by aria-describedby) after a confirm it failed. The
 * trigger may carry a decorative icon; its accessible name stays exactly `triggerLabel`. A
 * destructive trigger is a danger outline, and the dialog's confirm is the solid danger button.
 */
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Ban, Check, KeyRound, OctagonPause, Play, RotateCw, Send, X, type LucideIcon } from 'lucide-react';
import { ConfirmDialog, type ConfirmOutcome } from '@/components/patterns/ConfirmDialog';
import { CSRF_HEADER_NAME } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ADMIN_REASON_MAX, ADMIN_REASON_MIN, RESEND_CONFIRM_TEXT } from '@/lib/schemas/admin';

type PostResult = { ok: true; data: unknown } | { ok: false; status: number; code: string | null; message: string; reference: string | null };

async function post(url: string, body: unknown, csrf: string | null): Promise<PostResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (csrf) headers[CSRF_HEADER_NAME] = csrf;
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    return { ok: false, status: 0, code: null, message: 'The server could not be reached. Check your connection and try again.', reference: null };
  }
  const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok) return { ok: true, data: parsed };
  return {
    ok: false,
    status: res.status,
    code: typeof parsed?.code === 'string' ? parsed.code : null,
    message: typeof parsed?.message === 'string' ? parsed.message : 'The request failed. Try again.',
    reference: typeof parsed?.reference === 'string' ? parsed.reference : res.headers.get('x-request-id'),
  };
}

/**
 * A destructive trigger is a danger outline: it names the risk without becoming the loudest thing
 * on the page (the solid danger fill is kept for the confirm button inside the dialog).
 */
const DANGER_OUTLINE = 'border-danger/55 text-danger hover:border-danger hover:bg-danger/10 hover:text-danger';

const TRIGGER_ICONS = { pause: OctagonPause, resume: Play, retry: RotateCw, cancel: Ban, delivered: Check, 'not-delivered': X, resend: Send } satisfies Record<string, LucideIcon>;
export type AdminActionIcon = keyof typeof TRIGGER_ICONS;

export type AdminActionProps = {
  triggerLabel: string;
  title: string;
  description: string;
  confirmLabel: string;
  endpoint: string;
  /** Request body without the reason (and confirm text), which the dialog adds. */
  body: Record<string, unknown>;
  successMessage: string;
  /** Typed confirmation the operator must enter (sent as `confirmText`). */
  confirmText?: string;
  destructive?: boolean;
  variant?: 'default' | 'outline' | 'destructive' | 'secondary';
  mode: 'demo' | 'live';
  workspaceName?: string;
  /** Decorative trigger icon (aria-hidden; the name stays triggerLabel). */
  icon?: AdminActionIcon;
  size?: 'sm' | 'default';
  className?: string;
};

export function AdminAction(props: AdminActionProps) {
  const router = useRouter();
  const pageCsrf = useCsrfToken();
  const [csrf, setCsrf] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [needsReauth, setNeedsReauth] = useState(false);
  const [password, setPassword] = useState('');
  const [reauthError, setReauthError] = useState<string | null>(null);
  const [reauthing, setReauthing] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const fieldId = useId();
  const reasonId = `${fieldId}-reason`;
  const reasonHelpId = `${fieldId}-reason-help`;
  const confirmId = `${fieldId}-confirm`;
  const passwordId = `${fieldId}-password`;
  const reasonLength = reason.trim().length;
  const reasonInvalid = attempted && reasonLength < ADMIN_REASON_MIN;
  const typedInvalid = attempted && Boolean(props.confirmText) && typed !== props.confirmText;

  /** Each opening starts clean: no reason, confirmation or reauth panel left from a cancelled try. */
  function resetForm() {
    setReason('');
    setTyped('');
    setNeedsReauth(false);
    setPassword('');
    setReauthError(null);
    setAttempted(false);
  }

  async function reauthenticate() {
    setReauthing(true);
    setReauthError(null);
    const result =
      props.mode === 'demo' ? await post('/api/demo/session', { persona: 'admin' }, null) : await post('/api/app/auth/reauth', { password }, csrf ?? pageCsrf);
    setReauthing(false);
    if (!result.ok) {
      setReauthError(result.message);
      return;
    }
    const token = (result.data as { csrfToken?: unknown } | null)?.csrfToken;
    setCsrf(typeof token === 'string' ? token : null);
    setPassword('');
    setNeedsReauth(false);
  }

  async function confirm(): Promise<ConfirmOutcome> {
    setAttempted(true);
    const trimmed = reason.trim();
    if (trimmed.length < ADMIN_REASON_MIN) return { ok: false, message: `Give a reason of at least ${ADMIN_REASON_MIN} characters.` };
    if (props.confirmText && typed !== props.confirmText) return { ok: false, message: `Type ${props.confirmText} to confirm.` };
    const body = { ...props.body, reason: trimmed, ...(props.confirmText ? { confirmText: typed } : {}) };
    const result = await post(props.endpoint, body, csrf ?? pageCsrf);
    if (result.ok) {
      toast.success(props.successMessage);
      resetForm();
      router.refresh();
      return { ok: true };
    }
    if (result.code === 'REAUTH_REQUIRED') {
      setNeedsReauth(true);
      return { ok: false, message: 'Confirm your identity below, then confirm the action again.' };
    }
    return { ok: false, message: result.message, reference: result.reference };
  }

  const TriggerIcon = props.icon ? TRIGGER_ICONS[props.icon] : null;

  return (
    <ConfirmDialog
      trigger={
        <Button
          variant={props.variant ?? 'outline'}
          size={props.size ?? 'sm'}
          className={cn(props.destructive && !props.variant && DANGER_OUTLINE, props.className)}
          onClick={resetForm}
        >
          {TriggerIcon ? <TriggerIcon aria-hidden="true" /> : null}
          {props.triggerLabel}
        </Button>
      }
      title={props.title}
      description={props.description}
      confirmLabel={props.confirmLabel}
      pendingLabel="Working..."
      destructive={props.destructive}
      workspaceName={props.workspaceName}
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={reasonId}>Reason (stored on the audit record)</Label>
          <Textarea
            id={reasonId}
            value={reason}
            maxLength={ADMIN_REASON_MAX}
            rows={3}
            aria-describedby={reasonHelpId}
            aria-invalid={reasonInvalid || undefined}
            onChange={(e) => setReason(e.target.value)}
          />
          <p id={reasonHelpId} className="flex flex-wrap justify-between gap-x-3 text-xs text-fg-2">
            <span className={reasonInvalid ? 'text-danger' : undefined}>At least {ADMIN_REASON_MIN} characters.</span>
            <span className="tabular">
              {reason.length}/{ADMIN_REASON_MAX}
            </span>
          </p>
        </div>
        {props.confirmText ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={confirmId}>Type {props.confirmText} to confirm</Label>
            <Input id={confirmId} value={typed} autoComplete="off" aria-invalid={typedInvalid || undefined} className="font-mono" onChange={(e) => setTyped(e.target.value)} />
          </div>
        ) : null}
        {needsReauth ? (
          <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 p-3">
            <p className="flex items-center gap-2 text-sm text-fg-1">
              <KeyRound aria-hidden="true" className="size-4 text-warning" />
              This action needs a sign-in within the last 15 minutes.
            </p>
            {props.mode === 'live' ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={passwordId}>Your password</Label>
                <Input id={passwordId} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
            ) : null}
            <Button type="button" size="sm" variant="secondary" onClick={reauthenticate} disabled={reauthing || (props.mode === 'live' && password.length === 0)}>
              {reauthing ? 'Confirming...' : props.mode === 'demo' ? 'Sign in again as Super admin (DEMO)' : 'Confirm password'}
            </Button>
            {reauthError ? (
              <p role="alert" className="text-sm text-danger">
                {reauthError}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}

export { RESEND_CONFIRM_TEXT };
