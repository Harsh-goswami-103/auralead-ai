'use client';

/**
 * AdminFormDialog (T29): one super admin mutation behind a confirmation. It states what will
 * happen (and the workspace, for a tenant action, F8), holds the action's own fields, always asks
 * for a typed reason (stored on the audit row) and runs the request once. A refusal keeps the
 * dialog open with the server's message and reference, so a failure never reads as success. When
 * the server asks for a fresh sign-in, the dialog offers it in place and the person confirms
 * again. On success it closes, toasts the server-confirmed result, hands the response to
 * `onSuccess` (for a link shown once) and refreshes the page from the database.
 *
 * Every opening starts clean: the reason and the sign-in panel reset, and `onOpen` lets the caller
 * reset its own fields. The reason states its rule up front and is marked invalid after a confirm
 * it failed.
 */
import { useId, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ConfirmDialog, type ConfirmOutcome } from '@/components/patterns/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ADMIN_REASON_MAX, ADMIN_REASON_MIN } from '@/lib/schemas/admin-people';
import { ReauthPanel, useAdminPost, type AdminMode } from './use-admin-post';

/** A destructive trigger is a danger outline; the solid danger fill stays on the dialog's confirm. */
const DANGER_OUTLINE = 'border-danger/55 text-danger hover:border-danger hover:bg-danger/10 hover:text-danger';

export type AdminFormDialogProps = {
  triggerLabel: string;
  /** Decorative trigger icon (aria-hidden by the caller); the accessible name stays triggerLabel. */
  triggerIcon?: ReactNode;
  triggerVariant?: 'default' | 'outline' | 'secondary' | 'ghost';
  triggerSize?: 'sm' | 'default';
  triggerClassName?: string;
  destructive?: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  workspaceName?: string;
  mode: AdminMode;
  endpoint: string;
  /** The request body without the reason; a string is a validation message that keeps the dialog open. */
  body: () => Record<string, unknown> | string;
  /** The toast after success (null for none, e.g. when a link is shown instead). */
  successMessage: (data: unknown) => string | null;
  onSuccess?: (data: unknown) => void;
  /** Resets the caller's fields each time the dialog opens. */
  onOpen?: () => void;
  children?: ReactNode;
};

export function AdminFormDialog(props: AdminFormDialogProps) {
  const router = useRouter();
  const api = useAdminPost(props.mode);
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const id = useId();
  const reasonInvalid = attempted && reason.trim().length < ADMIN_REASON_MIN;

  function open() {
    setReason('');
    setAttempted(false);
    api.resetReauth();
    props.onOpen?.();
  }

  async function confirm(): Promise<ConfirmOutcome> {
    setAttempted(true);
    const trimmed = reason.trim();
    const body = props.body();
    if (typeof body === 'string') return { ok: false, message: body };
    if (trimmed.length < ADMIN_REASON_MIN) return { ok: false, message: `Give a reason of at least ${ADMIN_REASON_MIN} characters.` };
    const result = await api.send(props.endpoint, { ...body, reason: trimmed });
    if (result.ok) {
      const message = props.successMessage(result.data);
      if (message) toast.success(message);
      props.onSuccess?.(result.data);
      router.refresh();
      return { ok: true };
    }
    if (result.code === 'REAUTH_REQUIRED') return { ok: false, message: 'Confirm your identity below, then confirm again.' };
    return { ok: false, message: result.message, reference: result.reference };
  }

  return (
    <ConfirmDialog
      trigger={
        <Button
          variant={props.triggerVariant ?? 'outline'}
          size={props.triggerSize ?? 'sm'}
          className={cn(props.destructive && !props.triggerVariant && DANGER_OUTLINE, props.triggerClassName)}
          onClick={open}
        >
          {props.triggerIcon}
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
        {props.children}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-reason`}>Reason (stored on the audit record)</Label>
          <Textarea
            id={`${id}-reason`}
            value={reason}
            maxLength={ADMIN_REASON_MAX}
            rows={2}
            aria-describedby={`${id}-reason-help`}
            aria-invalid={reasonInvalid || undefined}
            onChange={(e) => setReason(e.target.value)}
          />
          <p id={`${id}-reason-help`} className="flex flex-wrap justify-between gap-x-3 text-xs text-fg-2">
            <span className={reasonInvalid ? 'text-danger' : undefined}>At least {ADMIN_REASON_MIN} characters.</span>
            <span className="tabular">
              {reason.length}/{ADMIN_REASON_MAX}
            </span>
          </p>
        </div>
        {api.needsReauth ? <ReauthPanel mode={props.mode} reauthing={api.reauthing} error={api.reauthError} onReauth={api.reauthenticate} /> : null}
      </div>
    </ConfirmDialog>
  );
}
