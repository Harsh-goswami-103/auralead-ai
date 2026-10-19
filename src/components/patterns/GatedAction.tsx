'use client';

/**
 * GatedAction (plan §12, O4; 06-design F3). A control that is blocked stays focusable
 * (`aria-disabled="true"`, never the `disabled` attribute), shows its reason as visible text tied
 * by `aria-describedby`, and links to the fix when one exists. It may gate ONLY on configuration,
 * permission, mode or eligibility: `gate.category` is that closed union, so "not built yet" can
 * never be expressed. Ungated, it is an ordinary button (running `onAction`, busy while the
 * returned promise is pending, so double clicks do not repeat it) or link.
 */
import Link from 'next/link';
import { useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { VariantProps } from 'class-variance-authority';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';

export const GATE_CATEGORIES = ['configuration', 'permission', 'mode', 'eligibility'] as const;
export type GateCategory = (typeof GATE_CATEGORIES)[number];

export type Gate = {
  category: GateCategory;
  /** What blocks the action, in plain words (e.g. "WhatsApp window closed 2h ago."). */
  reason: string;
  /** Where the user can remove the block, when such a place exists. */
  fix?: { href: string; label: string };
};

type Common = {
  label: string;
  gate: Gate | null;
  icon?: ReactNode;
  pendingLabel?: string;
  className?: string;
  /**
   * Render the reason elsewhere (under a segmented control, say) with `<GateReason id={reasonId}>`.
   * The control then points at that id and renders no reason of its own.
   */
  reasonId?: string;
} & VariantProps<typeof buttonVariants>;

export type GatedActionProps =
  | (Common & { onAction: () => void | Promise<void>; href?: undefined })
  | (Common & { href: string; onAction?: undefined });

/** The visible reason line of a gated control (plan §12): what blocks it, and the fix link when one exists. */
export function GateReason(props: { id: string; gate: Gate; className?: string }) {
  const { gate } = props;
  return (
    <span id={props.id} className={cn('max-w-prose text-xs text-fg-2', props.className)}>
      {gate.reason}
      {gate.fix ? (
        <>
          {' '}
          <Link href={gate.fix.href} className="font-medium text-cyan underline-offset-4 hover:underline">
            {gate.fix.label}
          </Link>
        </>
      ) : null}
    </span>
  );
}

export function GatedAction(props: GatedActionProps) {
  const ownReasonId = useId();
  const reasonId = props.reasonId ?? ownReasonId;
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  const { gate, label, icon, variant, size, className } = props;
  const classes = cn(buttonVariants({ variant, size }), 'aria-disabled:cursor-not-allowed aria-disabled:opacity-55', className);

  if (gate !== null) {
    const blockActivation = (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const control =
      props.href !== undefined ? (
        <a role="link" tabIndex={0} aria-disabled="true" aria-describedby={reasonId} data-gate-category={gate.category} onClick={blockActivation} className={classes}>
          {icon}
          {label}
        </a>
      ) : (
        <button type="button" aria-disabled="true" aria-describedby={reasonId} data-gate-category={gate.category} onClick={blockActivation} className={classes}>
          {icon}
          {label}
        </button>
      );
    if (props.reasonId) return control;
    return (
      <span className="inline-flex flex-col items-start gap-1">
        {control}
        <GateReason id={reasonId} gate={gate} />
      </span>
    );
  }

  if (props.href !== undefined) {
    return (
      <Link href={props.href} className={classes}>
        {icon}
        {label}
      </Link>
    );
  }

  const onAction = props.onAction;
  async function run() {
    if (running.current) return;
    running.current = true;
    setPending(true);
    try {
      await onAction();
    } finally {
      running.current = false;
      setPending(false);
    }
  }

  return (
    <button type="button" aria-busy={pending || undefined} onClick={() => void run()} className={classes}>
      {icon}
      {pending && props.pendingLabel ? props.pendingLabel : label}
    </button>
  );
}
