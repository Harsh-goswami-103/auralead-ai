'use client';

/**
 * Account menu: who is signed in, in which role, and sign out (POST /api/app/auth/logout with the
 * session's CSRF token; the route revokes the session row and clears the cookie).
 */
import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { toast } from 'sonner';
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

export function UserMenu({ user }: { user: MenuUser }) {
  const { pending, signOut } = useSignOut();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account: ${user.name}`}
        className="flex size-9 items-center justify-center rounded-full border border-border-strong bg-bg-2 text-xs font-semibold text-fg-1 transition-colors duration-150 hover:bg-bg-3"
      >
        {initials(user.name)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 border-border-strong bg-bg-1">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="truncate text-fg-1">{user.name}</span>
          <span className="truncate text-xs font-normal text-fg-2">{user.email}</span>
          <span className="text-xs font-normal text-fg-3">
            {ROLE_LABELS[user.role]}
            {user.isDemo ? ' (demo identity)' : ''}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()} disabled={pending}>
          <LogOut aria-hidden="true" />
          {pending ? 'Signing out...' : 'Sign out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
