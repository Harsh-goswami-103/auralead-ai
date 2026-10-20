'use client';

/**
 * ErrorState (06-design §11.3): always shows the correlation ID ("Reference") and never a stack
 * trace or raw internal message. Only an AppError's `userMessage` or an explicit `message` from
 * the caller reaches the screen; any other thrown value becomes the generic sentence.
 *
 * Look (design spec §6): a 4px danger edge, the icon in a danger-tinted disc, the reference as a
 * mono chip with a copy button (a real clipboard write that confirms with a toast), and "Try again"
 * with a rotate icon. The danger hue stays a flat tint with icon and text; it is never a gradient
 * or color alone.
 */
import { CircleAlert, Copy, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { AppError } from '@/lib/errors/app-error';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';

export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Quote the reference if you contact support.';

function visibleMessage(error: unknown, message: string | undefined): string {
  if (message) return message;
  if (error instanceof AppError) return error.userMessage;
  return GENERIC_ERROR_MESSAGE;
}

async function copyReference(reference: string) {
  try {
    await navigator.clipboard.writeText(reference);
    toast.success('Reference copied');
  } catch {
    toast.error('The reference could not be copied. Select it and copy it instead.');
  }
}

export function ErrorState(props: {
  correlationId: string;
  title?: string;
  /** A user-facing sentence chosen by the caller (already safe to show). */
  message?: string;
  /** The thrown value. Only an AppError's userMessage is ever displayed from it. */
  error?: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div role="alert" className={cn('relative flex flex-col gap-3 overflow-hidden rounded-xl border border-danger/35 bg-danger/8 py-4 pr-4 pl-5', props.className)}>
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-danger" />
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-danger/15 text-danger ring-1 ring-danger/35 ring-inset">
          <CircleAlert className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-semibold text-fg-1">{props.title ?? 'This could not be loaded'}</p>
          <p className="text-fg-2">{visibleMessage(props.error, props.message)}</p>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-fg-2">
            Reference:
            <span className="rounded-sm border border-border-strong bg-bg-2 px-1.5 py-0.5 font-mono break-all text-fg-1 select-all">{props.correlationId}</span>
            <button
              type="button"
              onClick={() => void copyReference(props.correlationId)}
              aria-label="Copy reference"
              className="relative inline-flex size-6 items-center justify-center rounded-sm text-fg-2 transition-colors duration-fast hover:bg-bg-3 hover:text-fg-1 max-lg:before:absolute max-lg:before:-inset-2.5"
            >
              <Copy aria-hidden="true" className="size-3.5" />
            </button>
          </p>
        </div>
      </div>
      {props.onRetry ? (
        <div className="pl-11">
          <Button variant="outline" size="sm" onClick={props.onRetry} className="group">
            <RotateCw aria-hidden="true" className="transition-transform duration-slow ease-emphasized motion-safe:group-active:-rotate-90" />
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}
