'use client';

/**
 * WorkspaceChip (06-design F8): the current workspace's name, plan label and mode, always in the
 * top bar, so an operator never acts in the wrong tenant. The list holds only workspaces the
 * server resolved for this session (memberships or active assignments). Switching posts the slug
 * to /api/app/auth/active-workspace, which re-checks it; the browser never decides access.
 *
 * Look (design spec §6): the building icon sits in a panel-hue tile and the DEMO pill carries
 * the demo hatch. In the menu each workspace has a monogram tile, a plan pill, and a check on the
 * current one. The chip is a flex item of the top bar's middle slot: it is as wide as its content
 * (it no longer stretches across the bar) and shrinks with the name truncated, never into the
 * buttons beside it. The switch trigger is named by what it shows ("Workspace: <name> <plan>
 * <mode>. Switch workspace", the plan only where it is visible), so the visible words are always
 * part of the name (WCAG 2.5.3), and it has the 44px hit area below lg.
 */
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Building2, Check, ChevronsUpDown, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { touchTarget } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { postJson } from './api-client';
import { useCsrfToken } from './csrf';

export type ChipWorkspace = { slug: string; name: string; planLabel: string; mode: 'DEMO' | 'LIVE' };

function ModePill({ mode }: { mode: 'DEMO' | 'LIVE' }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-xs border px-1.5 text-[11px] leading-4 font-semibold',
        mode === 'DEMO' ? 'demo-hatch border-demo/50 text-demo' : 'border-success/40 bg-success/12 text-success',
      )}
    >
      {mode === 'DEMO' ? 'Demo' : 'Live'}
    </span>
  );
}

function ChipBody({ ws, placeholder }: { ws: ChipWorkspace | null; placeholder: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-md bg-panel/14 text-panel">
        <Building2 className="size-4" />
      </span>
      {ws ? (
        <>
          <span className="truncate font-medium text-fg-1">{ws.name}</span>{' '}
          <span className="hidden shrink-0 text-xs text-fg-2 md:inline">{ws.planLabel}</span>{' '}
          <ModePill mode={ws.mode} />
        </>
      ) : (
        <span className="truncate text-fg-2">{placeholder}</span>
      )}
    </span>
  );
}

function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? '')).toUpperCase();
}

export function WorkspaceChip(props: { current: ChipWorkspace | null; workspaces: ChipWorkspace[]; panel: 'user' | 'employee' }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ ws?: string }>();
  const csrf = useCsrfToken();
  const [pending, setPending] = useState<string | null>(null);

  // On /dashboard/employee/[ws]/... the URL segment names the workspace being acted in.
  const routeSlug = typeof params?.ws === 'string' ? params.ws : null;
  const current = (routeSlug ? props.workspaces.find((w) => w.slug === routeSlug) : null) ?? props.current;
  const placeholder = props.workspaces.length === 0 ? 'No workspace assigned' : 'Choose a workspace';

  if (props.workspaces.length <= 1 && current) {
    return (
      <div data-workspace-chip className="flex h-9 max-w-full min-w-0 items-center rounded-lg border border-border-subtle bg-bg-2/80 pr-3 pl-1">
        <ChipBody ws={current} placeholder={placeholder} />
      </div>
    );
  }
  if (props.workspaces.length === 0) {
    return (
      <div data-workspace-chip className="flex h-9 max-w-full min-w-0 items-center rounded-lg border border-dashed border-border-strong pr-3 pl-1">
        <ChipBody ws={null} placeholder={placeholder} />
      </div>
    );
  }

  async function switchTo(slug: string) {
    if (pending || slug === current?.slug) return;
    setPending(slug);
    const res = await postJson('/api/app/auth/active-workspace', { workspaceSlug: slug }, csrf);
    setPending(null);
    if (!res.ok) {
      toast.error(res.message, { description: res.reference ? `Reference: ${res.reference}` : undefined });
      return;
    }
    const target = props.workspaces.find((w) => w.slug === slug);
    toast.success(`Switched to ${target?.name ?? slug}`);
    if (routeSlug && pathname) router.push(pathname.replace(`/dashboard/employee/${routeSlug}`, `/dashboard/employee/${slug}`));
    else router.refresh();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-workspace-chip
        className={cn(
          'group relative flex h-9 max-w-[min(24rem,100%)] min-w-0 items-center gap-2 rounded-lg border border-border-subtle bg-bg-2/80 pr-2 pl-1 transition-colors duration-fast ease-enter hover:border-panel/45 hover:bg-bg-3 data-[state=open]:border-panel/45 data-[state=open]:bg-bg-3',
          touchTarget,
        )}
      >
        {current ? <span className="sr-only">Workspace:</span> : null}{' '}
        <ChipBody ws={current} placeholder={placeholder} />
        {current ? <span className="sr-only">. Switch workspace</span> : null}
        <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-fg-3 transition-colors duration-fast group-hover:text-fg-2" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[min(20rem,calc(100vw-2rem))] p-1.5">
        <DropdownMenuLabel className="flex items-center gap-2 px-2 pt-1.5 pb-2 text-[11px] font-semibold tracking-[0.14em] text-fg-2 uppercase">
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-panel" />
          {props.panel === 'employee' ? 'Assigned workspaces' : 'Your workspaces'}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {props.workspaces.map((w) => {
          const isCurrent = w.slug === current?.slug;
          return (
            <DropdownMenuItem key={w.slug} onSelect={() => void switchTo(w.slug)} className="flex items-center gap-3 py-2">
              <span
                aria-hidden="true"
                className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-md border font-display text-xs font-semibold',
                  isCurrent ? 'border-panel/35 bg-panel/14 text-panel' : 'border-border-subtle bg-bg-1 text-fg-2',
                )}
              >
                {pending === w.slug ? <LoaderCircle className="size-4 motion-safe:animate-spin" /> : monogram(w.name)}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-fg-1">{pending === w.slug ? `Switching to ${w.name}...` : w.name}</span>
                <span className="flex items-center gap-1.5 text-xs text-fg-2">
                  <span className="truncate">{w.planLabel}</span>
                  <ModePill mode={w.mode} />
                </span>
              </span>
              {isCurrent ? <Check aria-label="Current workspace" className="size-4 shrink-0 text-panel" /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
