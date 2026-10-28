'use client';

/**
 * "Generate with AI" (lead-gen B2): the one control the inbox (F3), the template studio (F4) and
 * the handoff summary (F5) use to ask for AI-written text.
 * - AI style: an outline button in violet with a sparkle icon (the --ai token is legal only under
 *   src/components/ai/**, lint rule AI_TOKEN).
 * - Loading: while the action's promise runs, or while the caller says the result is still pending
 *   (a queued job), the button is busy (aria-busy, a spinner in place of the sparkle, the pending
 *   label) and repeat clicks are ignored. It never uses the disabled attribute, so focus stays put.
 * - `local`: the labelled local generator is not AI (truthful UI), so the same control reads
 *   "Generate with local template" with the neutral outline look and a wand icon.
 * - `gate`: a configuration, permission, mode or eligibility block (plan section 12) renders the
 *   shared GatedAction: inert, focusable, with its reason and fix link, never violet.
 */
import { useRef, useState } from 'react';
import { LoaderCircle, Sparkles, WandSparkles } from 'lucide-react';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';

export const AI_ACTION_LABEL = 'Generate with AI';
export const LOCAL_ACTION_LABEL = 'Generate with local template';
const DEFAULT_PENDING_LABEL = 'Generating...';

const AI_CLASSES = 'border-ai/50 text-ai hover:border-ai hover:bg-ai/10 hover:text-ai';

export type AiActionButtonProps = {
  onAction: () => void | Promise<void>;
  label?: string;
  pendingLabel?: string;
  /** The caller's own busy state, e.g. waiting for the job that writes the text. */
  pending?: boolean;
  /** The local deterministic generator runs instead of a model (DEMO, or an explicit local action). */
  local?: boolean;
  gate?: Gate | null;
  size?: 'default' | 'xs' | 'sm' | 'lg';
  className?: string;
};

export function AiActionButton(props: AiActionButtonProps) {
  const [running, setRunning] = useState(false);
  const inFlight = useRef(false);
  const local = props.local ?? false;
  const label = props.label ?? (local ? LOCAL_ACTION_LABEL : AI_ACTION_LABEL);
  const size = props.size ?? 'default';

  if (props.gate) return <GatedAction label={label} gate={props.gate} size={size} className={props.className} />;

  const busy = running || (props.pending ?? false);
  const run = async () => {
    if (inFlight.current || props.pending) return;
    inFlight.current = true;
    setRunning(true);
    try {
      await props.onAction();
    } finally {
      inFlight.current = false;
      setRunning(false);
    }
  };

  return (
    <button
      type="button"
      data-ai-action={local ? 'local' : 'ai'}
      data-size={size}
      aria-busy={busy || undefined}
      onClick={() => void run()}
      className={cn(buttonVariants({ variant: 'outline', size }), !local && AI_CLASSES, props.className)}
    >
      {busy ? (
        <LoaderCircle aria-hidden="true" data-icon="spinner" className="motion-safe:animate-spin" />
      ) : local ? (
        <WandSparkles aria-hidden="true" data-icon="wand" />
      ) : (
        <Sparkles aria-hidden="true" data-icon="sparkles" />
      )}
      {busy ? (props.pendingLabel ?? DEFAULT_PENDING_LABEL) : label}
    </button>
  );
}
