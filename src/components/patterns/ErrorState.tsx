'use client';

/**
 * ErrorState (06-design §11.3): always shows the correlation ID ("Reference") and never a stack
 * trace or raw internal message. Only an AppError's `userMessage` or an explicit `message` from
 * the caller reaches the screen; any other thrown value becomes the generic sentence.
 */
import { CircleAlert } from 'lucide-react';
import { AppError } from '@/lib/errors/app-error';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';

export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Quote the reference if you contact support.';

function visibleMessage(error: unknown, message: string | undefined): string {
  if (message) return message;
  if (error instanceof AppError) return error.userMessage;
  return GENERIC_ERROR_MESSAGE;
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
    <div role="alert" className={cn('flex flex-col gap-3 rounded-lg border border-danger/30 bg-danger/5 p-4', props.className)}>
      <div className="flex items-start gap-2">
        <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
        <div className="flex flex-col gap-1">
          <p className="font-semibold text-fg-1">{props.title ?? 'This could not be loaded'}</p>
          <p className="text-fg-2">{visibleMessage(props.error, props.message)}</p>
          <p className="text-xs text-fg-3">
            Reference: <span className="font-mono text-fg-2 select-all">{props.correlationId}</span>
          </p>
        </div>
      </div>
      {props.onRetry ? (
        <div>
          <Button variant="outline" size="sm" onClick={props.onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}
