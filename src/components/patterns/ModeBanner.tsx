/**
 * Mode and pause banners (06-design §11.6). DEMO: a non-dismissible 32px hatched banner on every
 * authenticated page. LIVE: no banner. A global outbound pause shows a danger banner; a workspace
 * automation pause shows a warning banner. Icons + text, never color alone. Server-renderable.
 *
 * Aurora look (design spec §6): each banner's icon sits in a small tinted chip, and the DEMO
 * banner has a stronger demo edge. Status and demo hues stay flat tints: they never appear in a
 * gradient and are never decoration (spec §0.3).
 */
import type { ReactNode } from 'react';
import { CirclePause, FlaskConical, OctagonPause } from 'lucide-react';

function IconChip({ children, className }: { children: ReactNode; className: string }) {
  return (
    <span aria-hidden="true" className={`flex size-5 shrink-0 items-center justify-center rounded-full ring-1 ring-inset ${className}`}>
      {children}
    </span>
  );
}

export function ModeBanner(props: { mode: 'demo' | 'live'; outboundPaused?: boolean; automationPaused?: { workspaceName: string } | null }) {
  return (
    <>
      {props.mode === 'demo' ? (
        <div
          role="region"
          aria-label="Demo mode"
          data-mode-banner="demo"
          className="demo-hatch flex h-8 items-center justify-center gap-2 border-b border-demo/50 px-4 text-xs font-medium text-fg-1"
        >
          <IconChip className="bg-demo/20 ring-demo/45">
            <FlaskConical className="size-3 text-demo" />
          </IconChip>
          <span className="truncate">
            <span className="font-semibold tracking-wide text-demo">DEMO MODE:</span> simulated providers<span className="hidden sm:inline">, no messages leave this app</span>.
          </span>
        </div>
      ) : null}
      {props.outboundPaused ? (
        <div role="alert" data-pause-banner="global" className="flex min-h-8 items-center justify-center gap-2 border-b border-danger/50 bg-danger/16 px-4 py-1 text-xs font-medium text-fg-1">
          <IconChip className="bg-danger/20 ring-danger/45">
            <OctagonPause className="size-3 text-danger" />
          </IconChip>
          Outbound paused globally by admin. No message or provider action will be sent.
        </div>
      ) : null}
      {props.automationPaused ? (
        <div role="status" data-pause-banner="workspace" className="flex min-h-8 items-center justify-center gap-2 border-b border-warning/50 bg-warning/12 px-4 py-1 text-xs font-medium text-fg-1">
          <IconChip className="bg-warning/20 ring-warning/45">
            <CirclePause className="size-3 text-warning" />
          </IconChip>
          Automation paused in {props.automationPaused.workspaceName}. Automated sends wait until it is resumed.
        </div>
      ) : null}
    </>
  );
}
