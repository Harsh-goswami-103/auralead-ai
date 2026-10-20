'use client';

/**
 * GatedAction (plan §12, O4; 06-design F3). A control that is blocked stays focusable
 * (`aria-disabled="true"`, never the `disabled` attribute), shows its reason as visible text tied
 * by `aria-describedby`, and links to the fix when one exists. It may gate ONLY on configuration,
 * permission, mode or eligibility: `gate.category` is that closed union, so "not built yet" can
 * never be expressed. Ungated, it is an ordinary button (running `onAction`, busy while the
 * returned promise is pending, so double clicks do not repeat it) or link.
 *
 * Gated look (design spec §6, shots report "gated primary buttons look clickable"): whatever the
 * requested variant, a gated control renders inert. It has a dashed input-colored border, muted
 * text, no fill, sheen or press, a lock in place of its icon, and a not-allowed cursor. The
 * reason line starts with a glyph for its category. All icons are aria-hidden, so the control's
 * name is exactly its label and the reason's text is exactly the reason.
 */
import Link from 'next/link';
import { useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { ArrowRight, Ban, FlaskConical, Lock, Settings2, ShieldAlert, type LucideIcon } from 'lucide-react';
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
  | (Common & { href: string; onAction?: undefined })
  /** Always gated in this render (a server page, or a permission the viewer lacks): nothing to run. */
  | (Omit<Common, 'gate'> & { gate: Gate; onAction?: undefined; href?: undefined });

const CATEGORY_ICONS: Readonly<Record<GateCategory, LucideIcon>> = {
  configuration: Settings2,
  permission: ShieldAlert,
  mode: FlaskConical,
  eligibility: Ban,
};

/** Inert look shared by every gated control (applied over the outline variant). */
const GATED_CLASSES =
  'cursor-not-allowed border-dashed border-border-input bg-bg-1/40 text-fg-3 shadow-none hover:bg-bg-1/40 hover:text-fg-3 motion-safe:active:scale-100';

/** The visible reason line of a gated control (plan §12): what blocks it, and the fix link when one exists. */
export function GateReason(props: { id: string; gate: Gate; className?: string }) {
  const { gate } = props;
  const Icon = CATEGORY_ICONS[gate.category];
  return (
    <span id={props.id} className={cn('inline-flex max-w-prose items-start gap-1.5 text-xs text-fg-2', props.className)}>
      <Icon aria-hidden="true" className="mt-px size-3.5 shrink-0 text-info" />
      <span>
        {gate.reason}
        {gate.fix ? (
          <>
            {' '}
            <Link href={gate.fix.href} className="group inline-flex items-center gap-0.5 font-medium text-cyan underline-offset-4 hover:underline">
              {gate.fix.label}
              <ArrowRight aria-hidden="true" className="size-3 transition-transform duration-fast motion-safe:group-hover:translate-x-0.5" />
            </Link>
          </>
        ) : null}
      </span>
    </span>
  );
}

export function GatedAction(props: GatedActionProps) {
  const ownReasonId = useId();
  const reasonId = props.reasonId ?? ownReasonId;
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  const { label, icon, variant, size, className } = props;
  const classes = cn(buttonVariants({ variant, size }), className);

  if (props.gate !== null) {
    const gate = props.gate;
    const gatedClasses = cn(buttonVariants({ variant: 'outline', size }), GATED_CLASSES, className);
    const gatedIcon = <Lock aria-hidden="true" />;
    const blockActivation = (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const control =
      props.href !== undefined ? (
        <a role="link" tabIndex={0} aria-disabled="true" aria-describedby={reasonId} data-gate-category={gate.category} onClick={blockActivation} className={gatedClasses}>
          {gatedIcon}
          {label}
        </a>
      ) : (
        <button type="button" aria-disabled="true" aria-describedby={reasonId} data-gate-category={gate.category} onClick={blockActivation} className={gatedClasses}>
          {gatedIcon}
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

  // Only the always-gated form omits both onAction and href, and it returned above.
  const onAction = props.onAction;
  if (onAction === undefined) return null;
  const run = async () => {
    if (running.current) return;
    running.current = true;
    setPending(true);
    try {
      await onAction();
    } finally {
      running.current = false;
      setPending(false);
    }
  };

  return (
    <button type="button" aria-busy={pending || undefined} onClick={() => void run()} className={classes}>
      {icon}
      {pending && props.pendingLabel ? props.pendingLabel : label}
    </button>
  );
}
