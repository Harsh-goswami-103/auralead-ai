'use client';

/**
 * Account menu: who is signed in, in which role, a link to the documentation (/docs, T37), and sign
 * out (POST /api/app/auth/logout with the session's CSRF token; the route revokes the session row
 * and clears the cookie).
 *
 * Look (design spec §6): the initials avatar sits in a 2px ring of the panel gradient. The menu
 * opens on an identity card: the avatar, name, email, and a role chip with the panel-hue dot.
 * Sign out tints toward danger on hover, since it ends the session. The trigger's name starts
 * with the initials it shows, so speech input can say what it sees (WCAG 2.5.3).
 */
import Link from 'next/link';
import { useState } from 'react';
import { BookOpen, LoaderCircle, LogOut } from 'lucide-react';
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
import { isSafeRedirect, postJson } from './api-client';
import { useCsrfToken } from './csrf';

export const ROLE_LABELS = { USER: 'Workspace user', EMPLOYEE: 'Employee', SUPER_ADMIN: 'Super admin' } as const;

export type MenuUser = { name: string; email: string; role: keyof typeof ROLE_LABELS; isDemo: boolean };

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length >= 2 ? `${parts[0]![0]}${parts[parts.length - 1]![0]}` : (parts[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

export function useSignOut() {
  const csrf = useCsrfToken();
  const [pending, setPending] = useState(false);
  async function signOut() {
    if (pending) return;
    setPending(true);
    const res = await postJson<{ redirectTo?: unknown }>('/api/app/auth/logout', {}, csrf);
    if (res.ok) {
      window.location.assign(isSafeRedirect(res.data.redirectTo) ? res.data.redirectTo : '/login');
      return;
    }
    setPending(false);
    toast.error(res.message, { description: res.reference ? `Reference: ${res.reference}` : undefined });
  }
  return { pending, signOut };
}

/** Initials in a 2px panel-gradient ring. Decorative: the trigger or the label beside it names the person. */
function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden="true" className={cn('flex shrink-0 rounded-full bg-(image:--panel-grad) p-0.5', className)}>
      <span className="flex size-full items-center justify-center rounded-full bg-bg-2 font-display text-xs font-semibold text-fg-1">{initials(name)}</span>
    </span>
  );
}

export function UserMenu({ user }: { user: MenuUser }) {
  const { pending, signOut } = useSignOut();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${initials(user.name)}, account: ${user.name}`}
        className="group relative flex size-9 shrink-0 items-center justify-center rounded-full transition-transform duration-fast ease-enter max-lg:before:absolute max-lg:before:-inset-1 motion-safe:hover:scale-105 data-[state=open]:scale-105"
      >
        <Avatar name={user.name} className="size-9" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(18rem,calc(100vw-2rem))] p-1.5">
        <DropdownMenuLabel className="flex items-center gap-3 px-2 py-2 font-normal">
          <Avatar name={user.name} className="size-10" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate font-medium text-fg-1">{user.name}</span>
            <span className="truncate text-xs text-fg-2">{user.email}</span>
            <span className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-full border border-panel/30 bg-panel/12 px-2 py-px text-[11px] leading-4 font-medium text-fg-1">
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-panel" />
              {ROLE_LABELS[user.role]}
              {user.isDemo ? ' (demo identity)' : ''}
            </span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="py-2">
          <Link href="/docs">
            <BookOpen aria-hidden="true" className="text-fg-2" />
            Documentation
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => void signOut()}
          disabled={pending}
          className="py-2 focus:bg-danger/12"
        >
          {pending ? (
            <LoaderCircle aria-hidden="true" className="text-fg-2 motion-safe:animate-spin" />
          ) : (
            <LogOut aria-hidden="true" className="text-danger" />
          )}
          {pending ? 'Signing out...' : 'Sign out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
