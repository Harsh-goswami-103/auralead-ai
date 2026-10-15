/**
 * Mode and pause banners (06-design §11.6). DEMO: a non-dismissible 32px hatched banner on every
 * authenticated page. LIVE: no banner. A global outbound pause shows a danger banner; a workspace
 * automation pause shows a warning banner. Icons + text, never color alone. Server-renderable.
 */
import { CirclePause, FlaskConical, OctagonPause } from 'lucide-react';

export function ModeBanner(props: { mode: 'demo' | 'live'; outboundPaused?: boolean; automationPaused?: { workspaceName: string } | null }) {
  return (
    <>
      {props.mode === 'demo' ? (
        <div
          role="region"
          aria-label="Demo mode"
          data-mode-banner="demo"
          className="demo-hatch flex h-8 items-center justify-center gap-2 border-b border-demo/30 px-4 text-xs font-medium text-fg-1"
        >
          <FlaskConical aria-hidden="true" className="size-3.5 shrink-0 text-demo" />
          <span className="truncate">
            <span className="font-semibold text-demo">DEMO MODE:</span> simulated providers<span className="hidden sm:inline">, no messages leave this app</span>.
          </span>
        </div>
      ) : null}
      {props.outboundPaused ? (
        <div role="alert" data-pause-banner="global" className="flex min-h-8 items-center justify-center gap-2 border-b border-danger/40 bg-danger/15 px-4 py-1 text-xs font-medium text-fg-1">
          <OctagonPause aria-hidden="true" className="size-3.5 shrink-0 text-danger" />
          Outbound paused globally by admin. No message or provider action will be sent.
        </div>
      ) : null}
      {props.automationPaused ? (
        <div role="status" data-pause-banner="workspace" className="flex min-h-8 items-center justify-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-1 text-xs font-medium text-fg-1">
          <CirclePause aria-hidden="true" className="size-3.5 shrink-0 text-warning" />
          Automation paused in {props.automationPaused.workspaceName}. Automated sends wait until it is resumed.
        </div>
      ) : null}
    </>
  );
}
