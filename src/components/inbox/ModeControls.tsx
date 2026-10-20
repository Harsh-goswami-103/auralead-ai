'use client';

/**
 * AI mode and human takeover for one thread (T22 over T21; 06-design F7, §11.3 "Takeover/resume").
 * Every change opens a confirmation, carries the mode version on screen (a stale tab gets the
 * server's 409) and is audited by the service. Auto is offered only while workspace auto-send is on
 * and the person holds `automation.manage`; otherwise it is gated with the reason. Takeover shows the
 * banner "You are handling this thread. AI replies paused."; replies already queued are cancelled at
 * dispatch (the thread then shows "AI reply cancelled by takeover").
 *
 * Aurora look (design spec §2, user report "segmented control breaks"): the three modes are one
 * segmented control (role=group "AI mode") with a pill that slides to the current mode (motion
 * layoutId; a crossfade under reduced motion). A gated segment stays in the row with its lock, and
 * its reason is printed once under the whole control (GatedAction's reasonId + GateReason), so the
 * row never breaks. The takeover banner is an info strip with the hand in a chip. "Take over" sits
 * at the row's end only when the row has room for all of it (a container query), so in a narrow
 * column it wraps to the start of the next line instead of hanging alone on the right.
 */
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { motion } from 'motion/react';
import { Bot, CircleAlert, Hand, Play } from 'lucide-react';
import { spring } from '@/components/motion/presets';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { GatedAction, GateReason, type Gate } from '@/components/patterns/GatedAction';
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
  const baseId = useId();
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

  const segmentGate = (value: (typeof MODES)[number]['value']): Gate | null => (value === 'AUTO' ? autoGate : props.canChangeMode ? null : NO_MODE);
  // Each distinct reason is printed once under the control; gated segments point at it.
  const reasons: Array<{ id: string; gate: Gate }> = [];
  const reasonIdFor = (gate: Gate): string => {
    const found = reasons.find((r) => r.gate.reason === gate.reason);
    if (found) return found.id;
    const id = `${baseId}-reason-${reasons.length}`;
    reasons.push({ id, gate });
    return id;
  };
  const segment = 'relative isolate inline-flex min-h-8 items-center rounded-full px-3 py-1 text-sm font-medium';

  return (
    <div className="flex flex-col gap-3">
      {props.humanTakeover ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-info/35 bg-info/12 px-3 py-2.5"
          data-takeover-banner
        >
          <p className="flex items-center gap-2.5 text-sm font-medium text-fg-1">
            <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-full bg-info/16 text-info ring-1 ring-info/35">
              <Hand className="size-4 motion-safe:animate-reveal-focus" />
            </span>
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
            <GatedAction label="Resume AI" size="sm" variant="outline" gate={NO_MODE} />
          )}
        </div>
      ) : null}

      <div className="@container flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex items-center gap-1.5 text-sm text-fg-2">
          <Bot aria-hidden="true" className="size-4 text-panel" />
          AI mode
        </span>
        <div className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-full border border-border-strong bg-bg-2/80 p-1" role="group" aria-label="AI mode">
          {MODES.map((m) => {
            const current = m.value === props.aiMode;
            const pill = current ? (
              <motion.span layoutId={`ai-mode-pill-${baseId}`} transition={spring.smooth} aria-hidden="true" className="absolute inset-0 -z-10 rounded-full bg-aura/16 ring-1 ring-aura/45 ring-inset" />
            ) : null;
            if (current) {
              return (
                <span key={m.value} className="relative isolate inline-flex">
                  {pill}
                  <span aria-current="true" className={cn(segment, 'text-fg-1')} data-ai-mode={m.value}>
                    {m.label}
                  </span>
                </span>
              );
            }
            const gate = segmentGate(m.value);
            if (gate) {
              return (
                <GatedAction
                  key={m.value}
                  label={m.label}
                  size="sm"
                  variant="ghost"
                  gate={gate}
                  reasonId={reasonIdFor(gate)}
                  className="h-8 rounded-full border-transparent bg-transparent px-3 hover:bg-transparent [&_svg]:size-3.5"
                />
              );
            }
            return (
              <ConfirmDialog
                key={m.value}
                trigger={
                  <Button size="sm" variant="ghost" className="h-8 rounded-full px-3 text-fg-2 hover:bg-bg-3 hover:text-fg-1">
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
                <Button size="sm" variant="outline" className="@min-[30rem]:ml-auto">
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
            <span className="@min-[30rem]:ml-auto">
              <GatedAction label="Take over" size="sm" variant="outline" gate={NO_MODE} />
            </span>
          )
        ) : null}
      </div>
      {reasons.length > 0 ? (
        <div className="-mt-1 flex flex-col gap-1">
          {reasons.map((r) => (
            <GateReason key={r.id} id={r.id} gate={r.gate} />
          ))}
        </div>
      ) : null}

      {failure ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-fg-1">
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
