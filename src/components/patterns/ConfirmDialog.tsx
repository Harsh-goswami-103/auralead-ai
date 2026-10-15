'use client';

/**
 * ConfirmDialog (06-design F8, F19, F20): states what will happen, repeats the workspace name for
 * tenant actions, and runs the action once. `onConfirm` returns the outcome: on success the
 * dialog closes; on failure it stays open with the user-facing message and reference, so a
 * failure is never shown as success. Focus is trapped and returned by Radix AlertDialog.
 */
import { useRef, useState, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

export type ConfirmOutcome = { ok: true } | { ok: false; message: string; reference?: string | null };

export function ConfirmDialog(props: {
  trigger: ReactNode;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  cancelLabel?: string;
  /** Repeated in the dialog for every action inside a tenant (F8). */
  workspaceName?: string;
  destructive?: boolean;
  onConfirm: () => Promise<ConfirmOutcome> | ConfirmOutcome;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ message: string; reference: string | null } | null>(null);
  const running = useRef(false);

  async function confirm() {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setFailure(null);
    try {
      const outcome = await props.onConfirm();
      if (outcome.ok) setOpen(false);
      else setFailure({ message: outcome.message, reference: outcome.reference ?? null });
    } finally {
      running.current = false;
      setPending(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (!next) setFailure(null);
      }}
    >
      <AlertDialogTrigger asChild>{props.trigger}</AlertDialogTrigger>
      <AlertDialogContent className="border-border-strong bg-bg-1">
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription className="text-fg-2">{props.description}</AlertDialogDescription>
          {props.workspaceName ? <p className="text-sm font-medium text-fg-1">Workspace: {props.workspaceName}</p> : null}
        </AlertDialogHeader>
        {props.children}
        {failure ? (
          <p role="alert" className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-fg-1">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
            <span>
              {failure.message}
              {failure.reference ? <span className="block text-xs text-fg-2">Reference: {failure.reference}</span> : null}
            </span>
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{props.cancelLabel ?? 'Cancel'}</AlertDialogCancel>
          <Button variant={props.destructive ? 'destructive' : 'default'} aria-busy={pending || undefined} onClick={() => void confirm()}>
            {pending && props.pendingLabel ? props.pendingLabel : props.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
