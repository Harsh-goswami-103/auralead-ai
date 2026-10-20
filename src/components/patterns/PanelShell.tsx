/**
 * Authenticated panel chrome (06-design §11.2, design spec §6 "Shell"): skip link, DEMO and pause
 * banners, a sticky glass top bar (gradient product mark with the panel eyebrow, WorkspaceChip,
 * command palette, account) edged by a 1px panel-gradient hairline, a sidebar at 1024px and above,
 * and a bottom tab bar below that. The page content sits in PageTransition under a faint, static
 * panel-hue wash. The wash is not a loop, and it is kept at about 7% so that, stacked under a
 * PageHeader aurora, text stays near the 16% cap.
 *
 * Panel hues orient the user (which panel am I in?) and never mean "clickable". PanelSignature
 * copies data-panel onto <body> so portaled overlays use the same hue. The panel's name is shown
 * once, in the top bar's lockup (the sidebar below it starts straight with its links). The sidebar
 * column paints full height, and its nav sticks under the top bar inside a viewport-capped box, so
 * nothing in it falls below the fold behind the DEMO banner. Server component: everything shown comes from the
 * server-built PanelChrome; the interactive parts are small client islands.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { PanelChrome } from '@/server/services/shell/panel-chrome';
import { AuroraBackdrop } from '@/components/visual/AuroraBackdrop';
import { PageTransition } from '@/components/visual/PageTransition';
import { CommandPalette } from './CommandPalette';
import { CsrfProvider } from './csrf';
import { ModeBanner } from './ModeBanner';
import { BottomTabs, SidebarNav } from './PanelNav';
import { PANELS, type PanelKey } from './panel-nav';
import { PanelSignature } from './PanelSignature';
import { ProductMark } from './ProductMark';
import { UserMenu } from './UserMenu';
import { WorkspaceChip } from './WorkspaceChip';

export function PanelShell(props: { panel: PanelKey; chrome: PanelChrome; csrfToken: string; children: ReactNode }) {
  const { chrome, panel } = props;
  const definition = PANELS[panel];
  return (
    <CsrfProvider token={props.csrfToken}>
      <div data-panel={panel} className="flex min-h-dvh flex-col bg-bg-0">
        <PanelSignature panel={panel} />
        <a
          href="#main"
          className="sr-only z-50 rounded-md bg-primary font-medium text-primary-foreground shadow-overlay focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <ModeBanner
          mode={chrome.mode}
          outboundPaused={chrome.outboundPaused}
          automationPaused={chrome.automationPaused && chrome.workspace ? { workspaceName: chrome.workspace.name } : null}
        />
        <header className="surface-glass sticky top-0 z-30 border-b border-border-subtle">
          <div className="flex h-14 items-center gap-2.5 px-4 sm:gap-3 lg:px-6">
            <Link
              href={definition.home}
              className="group flex shrink-0 items-center gap-2.5 rounded-lg"
              aria-label={`AuraLead AI, ${definition.title} home`}
            >
              <ProductMark className="size-8 transition-transform duration-fast ease-enter motion-safe:group-hover:-rotate-6" />
              <span className="hidden flex-col sm:flex">
                <span className="font-display text-md leading-5 font-semibold tracking-tight text-fg-1">AuraLead</span>
                <span className="flex items-center gap-1.5 text-[10px] leading-3 font-semibold tracking-[0.16em] text-fg-2 uppercase">
                  <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-panel" />
                  {definition.title}
                </span>
              </span>
            </Link>
            <span aria-hidden="true" className="hidden h-6 w-px bg-border-strong sm:block" />
            {/* A flex row so the chip sizes to its content yet can shrink (min-w-0) instead of pushing into the search button. */}
            <div className="flex min-w-0 flex-1">
              {panel === 'admin' ? (
                <div className="flex h-9 max-w-full min-w-0 items-center gap-2 rounded-lg border border-border-subtle bg-bg-2/80 pr-3 pl-1 text-fg-1">
                  <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-md bg-panel/14 text-panel">
                    <ShieldCheck className="size-4" />
                  </span>
                  <span className="truncate font-medium">Platform</span>
                  <span className="hidden text-xs text-fg-2 sm:inline">All workspaces</span>
                </div>
              ) : (
                <WorkspaceChip panel={panel} current={chrome.workspace} workspaces={chrome.switchable} />
              )}
            </div>
            <CommandPalette panel={panel} />
            <UserMenu user={chrome.user} />
          </div>
          <span aria-hidden="true" className="hairline-panel absolute inset-x-0 -bottom-px opacity-80" />
        </header>
        <div className="flex flex-1">
          <aside className="hidden w-60 shrink-0 border-r border-border-subtle bg-bg-1/70 lg:block">
            <div className="sticky top-14 max-h-[calc(100dvh-3.5rem)] overflow-y-auto">
              <SidebarNav panel={panel} />
            </div>
          </aside>
          <main id="main" tabIndex={-1} className="relative isolate min-w-0 flex-1 px-4 pt-6 pb-28 outline-none lg:px-8 lg:pb-10">
            <AuroraBackdrop variant="empty" grain={false} className="bottom-auto h-72 opacity-50" />
            <div className="mx-auto w-full max-w-[1680px]">
              <PageTransition>{props.children}</PageTransition>
            </div>
          </main>
        </div>
        <BottomTabs panel={panel} />
      </div>
    </CsrfProvider>
  );
}
