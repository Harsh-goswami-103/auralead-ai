'use client';

/**
 * AI mode and human takeover for one thread (T22 over T21; 06-design F7, §11.3 "Takeover/resume").
 * Every change opens a confirmation, carries the mode version on screen (a stale tab gets the
 * server's 409) and is audited by the service. Auto is offered only while workspace auto-send is on
 * and the person holds `automation.manage`; otherwise it is gated with the reason. Takeover shows the
 * banner "You are handling this thread. AI replies paused."; replies already queued are cancelled at
 * dispatch (the thread then shows "AI reply cancelled by takeover").
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Bot, CircleAlert, Hand, Play } from 'lucide-react';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { useCsrfToken } from '@/components/patterns/csrf';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { postAction } from './api';

export type ModeControlsProps = {
  conversationId: string;
  workspaceName: string;
  aiMode: 'OFF' | 'DRAFT' | 'AUTO';
  humanTakeover: boolean;
  modeVersion: number;
  autoSendEnabled: boolean;
  autoAvailable: boolean;
  canChangeMode: boolean;
};

const MODES = [
  { value: 'OFF', label: 'Off', description: 'No AI replies are prepared for this thread.' },
  { value: 'DRAFT', label: 'Draft for approval', description: 'The AI prepares replies; a person approves each one before it is sent.' },
  { value: 'AUTO', label: 'Auto', description: 'Safe replies are sent automatically after the same checks as any send; complaints, human requests and anything unclear go to a person.' },
] as const;

const NO_MODE: Gate = { category: 'permission', reason: 'Your role cannot change how this conversation is handled.' };

export function ModeControls(props: ModeControlsProps) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const [failure, setFailure] = useState<{ message: string; reference: string | null } | null>(null);

  async function post(path: 'takeover' | 'resume' | 'mode', body: Record<string, unknown>, success: string) {
    setFailure(null);
    const res = await postAction(`/api/app/conversations/${props.conversationId}/${path}`, { expectedModeVersion: props.modeVersion, ...body }, csrf);
    if (!res.ok) {
      setFailure({ message: res.message, reference: res.reference });
      return { ok: false as const, message: res.message, reference: res.reference };
    }
    toast.success(success);
    router.refresh();
    return { ok: true as const };
  }

  const autoGate: Gate | null = !props.canChangeMode
    ? NO_MODE
    : !props.autoSendEnabled
      ? { category: 'configuration', reason: 'Workspace auto-send is off. It is an audited opt-in in the workspace settings.' }
      : !props.autoAvailable
        ? { category: 'permission', reason: 'Choosing Auto needs the automation permission.' }
        : null;

  return (
    <div className="flex flex-col gap-3">
      {props.humanTakeover ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-info/30 bg-info/10 px-3 py-2" data-takeover-banner>
          <p className="flex items-center gap-2 text-sm font-medium text-fg-1">
            <Hand aria-hidden="true" className="size-4 text-info" />
            You are handling this thread. AI replies paused.
          </p>
          {props.canChangeMode ? (
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="outline">
                  <Play aria-hidden="true" />
                  Resume AI
                </Button>
              }
              title="Resume AI on this conversation?"
              description={`AI replies follow the thread's mode (${MODES.find((m) => m.value === props.aiMode)!.label}) again. Replies that were held while you handled the thread stay cancelled.`}
              confirmLabel="Resume AI"
              pendingLabel="Resuming..."
              workspaceName={props.workspaceName}
              onConfirm={() => post('resume', {}, 'AI resumed on this conversation.')}
            />
          ) : (
            <GatedAction label="Resume AI" size="sm" variant="outline" gate={NO_MODE} onAction={() => setFailure(null)} />
          )}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-sm text-fg-2">
          <Bot aria-hidden="true" className="size-4" />
          AI mode
        </span>
        <div className="flex flex-wrap gap-1" role="group" aria-label="AI mode">
          {MODES.map((m) => {
            const current = m.value === props.aiMode;
            if (current) {
              return (
                <span key={m.value} aria-current="true" className={cn('rounded-md border px-2.5 py-1 text-sm font-medium', 'border-primary/50 bg-primary/10 text-fg-1')} data-ai-mode={m.value}>
                  {m.label}
                </span>
              );
            }
            const gate = m.value === 'AUTO' ? autoGate : props.canChangeMode ? null : NO_MODE;
            if (gate) return <GatedAction key={m.value} label={m.label} size="sm" variant="ghost" gate={gate} onAction={() => setFailure(null)} />;
            return (
              <ConfirmDialog
                key={m.value}
                trigger={
                  <Button size="sm" variant="ghost">
                    {m.label}
                  </Button>
                }
                title={`Set AI mode to ${m.label}?`}
                description={m.description}
                confirmLabel={`Set ${m.label}`}
                pendingLabel="Saving..."
                workspaceName={props.workspaceName}
                onConfirm={() => post('mode', { aiMode: m.value }, `AI mode set to ${m.label}.`)}
              />
            );
          })}
        </div>
        {!props.humanTakeover ? (
          props.canChangeMode ? (
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="outline" className="ml-auto">
                  <Hand aria-hidden="true" />
                  Take over
                </Button>
              }
              title="Take over this conversation?"
              description="You handle the replies. AI replies stop, including any already queued: they are cancelled at send."
              confirmLabel="Take over"
              pendingLabel="Taking over..."
              workspaceName={props.workspaceName}
              onConfirm={() => post('takeover', {}, 'You took over this conversation.')}
            />
          ) : (
            <GatedAction label="Take over" size="sm" variant="outline" gate={NO_MODE} onAction={() => setFailure(null)} />
          )
        ) : null}
      </div>

      {failure ? (
        <p role="alert" className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-fg-1">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
          <span>
            {failure.message}
            {failure.reference ? <span className="block text-xs text-fg-2">Reference: {failure.reference}</span> : null}
          </span>
        </p>
      ) : null}
    </div>
  );
}
