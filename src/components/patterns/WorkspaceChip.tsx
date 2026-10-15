'use client';

/**
 * WorkspaceChip (06-design F8): the current workspace's name, plan label and mode, always in the
 * top bar, so an operator never acts in the wrong tenant. The list holds only workspaces the
 * server resolved for this session (memberships or active assignments). Switching posts the slug
 * to /api/app/auth/active-workspace, which re-checks it; the browser never decides access.
 */
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Building2, Check, ChevronsUpDown } from 'lucide-react';
import { toast } from 'sonner';
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
        'rounded-xs border px-1 text-[11px] leading-4 font-medium',
        mode === 'DEMO' ? 'border-demo/40 bg-demo/10 text-demo' : 'border-success/40 bg-success/10 text-success',
      )}
    >
      {mode === 'DEMO' ? 'Demo' : 'Live'}
    </span>
  );
}

function ChipBody({ ws, placeholder }: { ws: ChipWorkspace | null; placeholder: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Building2 aria-hidden="true" className="size-4 shrink-0 text-fg-2" />
      {ws ? (
        <>
          <span className="truncate font-medium text-fg-1">{ws.name}</span>
          <span className="hidden truncate text-xs text-fg-2 sm:inline">{ws.planLabel}</span>
          <ModePill mode={ws.mode} />
        </>
      ) : (
        <span className="truncate text-fg-2">{placeholder}</span>
      )}
    </span>
  );
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
      <div data-workspace-chip className="flex h-9 min-w-0 items-center rounded-md border border-border-subtle bg-bg-2 px-3">
        <ChipBody ws={current} placeholder={placeholder} />
      </div>
    );
  }
  if (props.workspaces.length === 0) {
    return (
      <div data-workspace-chip className="flex h-9 min-w-0 items-center rounded-md border border-dashed border-border-strong px-3">
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
        aria-label={current ? `Workspace: ${current.name}, ${current.planLabel}, ${current.mode === 'DEMO' ? 'Demo' : 'Live'}. Switch workspace` : 'Choose a workspace'}
        className="flex h-9 max-w-[22rem] min-w-0 items-center gap-2 rounded-md border border-border-subtle bg-bg-2 px-3 transition-colors duration-150 hover:bg-bg-3"
      >
        <ChipBody ws={current} placeholder={placeholder} />
        <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-fg-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 border-border-strong bg-bg-1">
        <DropdownMenuLabel className="text-xs font-normal text-fg-2">
          {props.panel === 'employee' ? 'Assigned workspaces' : 'Your workspaces'}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {props.workspaces.map((w) => (
          <DropdownMenuItem key={w.slug} onSelect={() => void switchTo(w.slug)} className="flex items-center justify-between gap-2 py-2">
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-fg-1">{pending === w.slug ? `Switching to ${w.name}...` : w.name}</span>
              <span className="truncate text-xs text-fg-2">{w.planLabel}</span>
            </span>
            {w.slug === current?.slug ? <Check aria-label="Current workspace" className="size-4 text-cyan" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
