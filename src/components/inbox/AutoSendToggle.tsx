'use client';

/**
 * The workspace's "Automatic sending" switch (ADR-121) in the inbox header. It is the existing
 * `WorkspaceSettings.autoSendEnabled`, an audited opt-in, and it is labelled for everything it
 * controls: "AI replies and automated pipeline sends" (the same setting gates pipeline POLICY_AUTO
 * deliveries). A change opens a confirmation naming the workspace and posts to
 * `/api/app/settings/auto-send` (`automation.manage`, checked by the server for the workspace
 * named by `workspaceSlug` in the operator panel). Without the permission the switch is a
 * permission-gated control with its reason, never hidden. The state shown is the server's: after
 * a change the page re-reads itself.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { CircleAlert, Zap, ZapOff } from 'lucide-react';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { useCsrfToken } from '@/components/patterns/csrf';
import { cn } from '@/components/ui/cn';
import { postAction } from './api';

export const AUTO_SEND_LABEL = 'Automatic sending';
export const AUTO_SEND_SCOPE = 'AI replies and automated pipeline sends';

const NO_PERMISSION: Gate = { category: 'permission', reason: 'Changing automatic sending needs the automation permission in this workspace.' };

export function AutoSendToggle(props: { enabled: boolean; canManage: boolean; workspaceName: string; workspaceSlug?: string; className?: string }) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const [failure, setFailure] = useState<{ message: string; reference: string | null } | null>(null);
  const next = !props.enabled;
  const state = props.enabled ? 'On' : 'Off';

  async function change() {
    setFailure(null);
    const res = await postAction<{ enabled: boolean; changed: boolean }>('/api/app/settings/auto-send', { enabled: next, ...(props.workspaceSlug ? { workspaceSlug: props.workspaceSlug } : {}) }, csrf);
    if (!res.ok) {
      setFailure({ message: res.message, reference: res.reference });
      return { ok: false as const, message: res.message, reference: res.reference };
    }
    toast.success(next ? 'Automatic sending turned on.' : 'Automatic sending turned off.');
    router.refresh();
    return { ok: true as const };
  }

  const Icon = props.enabled ? Zap : ZapOff;
  const label = `${AUTO_SEND_LABEL}: ${state}`;
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', props.className)} data-auto-send={props.enabled ? 'on' : 'off'}>
      {props.canManage ? (
        <ConfirmDialog
          trigger={
            <button
              type="button"
              role="switch"
              aria-checked={props.enabled}
              aria-label={`${AUTO_SEND_LABEL} (${AUTO_SEND_SCOPE})`}
              className="inline-flex min-h-11 w-fit items-center gap-2.5 rounded-full border border-border-strong bg-bg-2 px-3 py-1.5 text-sm font-medium text-fg-1 transition-colors duration-fast hover:bg-bg-3 lg:min-h-9"
            >
              <span aria-hidden="true" className={cn('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-fast', props.enabled ? 'border-chat-accent bg-chat-accent' : 'border-border-strong bg-bg-3')}>
                <span className={cn('size-4 rounded-full bg-fg-1 transition-transform duration-fast', props.enabled ? 'translate-x-4' : 'translate-x-0.5')} />
              </span>
              <Icon aria-hidden="true" className="size-4 shrink-0 text-fg-2" />
              {label}
            </button>
          }
          title={next ? 'Turn on automatic sending?' : 'Turn off automatic sending?'}
          description={
            next
              ? `AI replies in conversations set to Auto, and automated pipeline sends, go out without a person approving each one. Every send still passes consent, opt-out and 24-hour window checks, and a person can take over any thread.`
              : 'Automated replies and automated pipeline sends stop: anything already queued is held at send, and an Auto conversation drafts its next reply for approval instead.'
          }
          confirmLabel={next ? 'Turn on' : 'Turn off'}
          pendingLabel="Saving..."
          workspaceName={props.workspaceName}
          onConfirm={change}
        />
      ) : (
        <GatedAction label={label} size="sm" variant="outline" gate={NO_PERMISSION} />
      )}
      <p className="text-xs text-fg-2">{AUTO_SEND_SCOPE}.</p>
      {failure ? (
        <p role="alert" className="flex items-start gap-2 text-sm text-fg-1">
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
