/**
 * Authenticated panel chrome (06-design §11.2): skip link, DEMO and pause banners, the sticky
 * glass top bar (product mark, WorkspaceChip, command palette, account), a sidebar at 1024px and
 * above, and a bottom tab bar below. Server component: everything it shows comes from the
 * server-built PanelChrome; interactive parts are small client islands.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { PanelChrome } from '@/server/services/shell/panel-chrome';
import { CommandPalette } from './CommandPalette';
import { CsrfProvider } from './csrf';
import { ModeBanner } from './ModeBanner';
import { BottomTabs, SidebarNav } from './PanelNav';
import { PANELS, type PanelKey } from './panel-nav';
import { ProductMark } from './ProductMark';
import { UserMenu } from './UserMenu';
import { WorkspaceChip } from './WorkspaceChip';

export function PanelShell(props: { panel: PanelKey; chrome: PanelChrome; csrfToken: string; children: ReactNode }) {
  const { chrome, panel } = props;
  const definition = PANELS[panel];
  return (
    <CsrfProvider token={props.csrfToken}>
      <div data-panel={panel} className="flex min-h-dvh flex-col bg-bg-0">
        <a
          href="#main"
          className="sr-only z-50 rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          Skip to content
        </a>
        <ModeBanner
          mode={chrome.mode}
          outboundPaused={chrome.outboundPaused}
          automationPaused={chrome.automationPaused && chrome.workspace ? { workspaceName: chrome.workspace.name } : null}
        />
        <header className="surface-glass sticky top-0 z-30 border-b border-border-subtle">
          <div className="flex h-14 items-center gap-3 px-4 lg:px-6">
            <Link href={definition.home} className="flex shrink-0 items-center gap-2 rounded-md" aria-label={`AuraLead AI, ${definition.title} home`}>
              <ProductMark className="size-7" />
              <span className="hidden font-display text-md font-semibold tracking-tight text-fg-1 sm:inline">AuraLead</span>
            </Link>
            <span aria-hidden="true" className="hidden h-5 w-px bg-border-strong sm:block" />
            <div className="min-w-0 flex-1">
              {panel === 'admin' ? (
                <div className="flex h-9 w-fit items-center gap-2 rounded-md border border-border-subtle bg-bg-2 px-3 text-fg-1">
                  <ShieldCheck aria-hidden="true" className="size-4 text-fg-2" />
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
        </header>
        <div className="flex flex-1">
          <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-60 shrink-0 overflow-y-auto border-r border-border-subtle bg-bg-1 lg:block">
            <SidebarNav panel={panel} />
          </aside>
          <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 pt-6 pb-28 outline-none lg:px-8 lg:pb-10">
            <div className="mx-auto w-full max-w-[1680px]">{props.children}</div>
          </main>
        </div>
        <BottomTabs panel={panel} />
      </div>
    </CsrfProvider>
  );
}
