'use client';

/**
 * ConfirmDialog (06-design F8, F19, F20): states what will happen, repeats the workspace name for
 * tenant actions, and runs the action once. `onConfirm` returns the outcome: on success the
 * dialog closes; on failure it stays open with the user-facing message and reference, so a
 * failure is never shown as success. Focus is trapped and returned by Radix AlertDialog.
 *
 * Look (design spec §5-§6): the dialog caps at the viewport and scrolls inside (ui/alert-dialog).
 * A non-destructive dialog keeps the panel hairline, and its confirm is the primary gradient
 * button. A destructive dialog swaps the hairline for a flat danger strip, shows a warning tile
 * beside the title, and uses the danger button. The workspace is a chip whose text stays
 * "Workspace: <name>". The chip wraps instead of truncating (F8 needs the whole name) and breaks
 * a long unspaced name; with the single minmax(0,1fr) columns no content can widen the dialog
 * past a phone screen. While pending, the confirm shows a spinner and its name becomes
 * pendingLabel. Radix unmounts the dialog on close (no Motion exit).
 */
import { useRef, useState, type ReactNode } from 'react';
import { Building2, CircleAlert, LoaderCircle, TriangleAlert } from 'lucide-react';
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
import { cn } from '@/components/ui/cn';

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
      <AlertDialogContent className={cn('grid-cols-[minmax(0,1fr)]', props.destructive && '[--grad-hairline:linear-gradient(var(--danger),var(--danger))]')}>
        <div className="flex items-start gap-4">
          {props.destructive ? (
            <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-danger/14 text-danger ring-1 ring-danger/35 ring-inset">
              <TriangleAlert className="size-5" />
            </span>
          ) : null}
          <AlertDialogHeader className="min-w-0 flex-1 grid-cols-[minmax(0,1fr)]">
            <AlertDialogTitle>{props.title}</AlertDialogTitle>
            <AlertDialogDescription className="text-fg-2">{props.description}</AlertDialogDescription>
            {props.workspaceName ? (
              <p className="mt-1 flex max-w-full min-w-0 items-center gap-1.5 rounded-xl border border-border-strong bg-bg-2 py-0.5 pr-2.5 pl-1 text-sm font-medium text-fg-1">
                <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-full bg-panel/14 text-panel">
                  <Building2 className="size-3" />
                </span>
                <span className="min-w-0 wrap-anywhere">Workspace: {props.workspaceName}</span>
              </p>
            ) : null}
          </AlertDialogHeader>
        </div>
        {props.children}
        {failure ? (
          <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/35 bg-danger/12 px-3 py-2 text-fg-1">
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
            {pending ? <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" /> : null}
            {pending && props.pendingLabel ? props.pendingLabel : props.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
