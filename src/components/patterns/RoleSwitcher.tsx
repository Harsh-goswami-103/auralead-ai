'use client';

/**
 * DEMO role switcher (PRD "Role switcher", P19, ADR-04). Loaded ONLY through the build-time gate
 * in DemoChrome.tsx, so a LIVE build contains none of this module (tests/unit/arch/live-bundle).
 * It offers the fixed persona keys; the server maps a key to a seeded `isDemo` user and issues an
 * ordinary DEMO session (POST /api/demo/session, 404 in LIVE). No privilege is decided here.
 */
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Check, ChevronUp, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { isSafeRedirect, postJson } from './api-client';

/** Mirrors DEMO_PERSONAS in src/server/auth/demo-personas.ts (checked by live-bundle.test.ts). */
export const SWITCHER_PERSONAS = [
  { key: 'user', label: 'Workspace owner', home: '/dashboard/user', hint: 'Client panel' },
  { key: 'employee', label: 'Employee', home: '/dashboard/employee', hint: 'Operator panel' },
  { key: 'admin', label: 'Super admin', home: '/dashboard/admin', hint: 'Platform panel' },
] as const;

type PersonaKey = (typeof SWITCHER_PERSONAS)[number]['key'];
type SwitchError = { message: string; reference: string | null };

function useSwitch() {
  const [pending, setPending] = useState<PersonaKey | null>(null);
  const [error, setError] = useState<SwitchError | null>(null);
  async function switchTo(persona: PersonaKey) {
    if (pending) return;
    setPending(persona);
    setError(null);
    const res = await postJson<{ redirectTo?: unknown }>('/api/demo/session', { persona });
    if (res.ok && isSafeRedirect(res.data.redirectTo)) {
      window.location.assign(res.data.redirectTo);
      return;
    }
    setError(res.ok ? { message: 'The demo session could not be started.', reference: null } : { message: res.message, reference: res.reference });
    setPending(null);
  }
  return { pending, error, switchTo };
}

function activePersona(pathname: string | null): PersonaKey | null {
  const hit = SWITCHER_PERSONAS.find((p) => pathname === p.home || pathname?.startsWith(`${p.home}/`));
  return hit?.key ?? null;
}

function PersonaButtons(props: { onPick: (key: PersonaKey) => void; pending: PersonaKey | null; active: PersonaKey | null; large?: boolean }) {
  return (
    <ul className="flex flex-col gap-1">
      {SWITCHER_PERSONAS.map((p) => {
        const isActive = props.active === p.key;
        return (
          <li key={p.key}>
            <button
              type="button"
              aria-current={isActive ? 'page' : undefined}
              aria-busy={props.pending === p.key || undefined}
              onClick={() => props.onPick(p.key)}
              className={cn(
                'flex w-full items-center justify-between gap-3 rounded-md border border-transparent px-3 text-left transition-colors duration-150 hover:bg-bg-3',
                props.large ? 'min-h-12 border-border-subtle bg-bg-2 py-2' : 'min-h-10 py-1.5',
                isActive && 'border-border-strong bg-bg-3',
              )}
            >
              <span className="flex flex-col">
                <span className="font-medium text-fg-1">{props.pending === p.key ? `Opening ${p.label.toLowerCase()}...` : p.label}</span>
                <span className="text-xs text-fg-2">{p.hint}</span>
              </span>
              {isActive ? <Check aria-hidden="true" className="size-4 text-cyan" /> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ErrorLine({ error }: { error: SwitchError | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="mt-2 text-xs text-danger">
      {error.message}
      {error.reference ? <span className="block text-fg-3">Reference: {error.reference}</span> : null}
    </p>
  );
}

/** Floating DEMO control on every route (bottom right, above the mobile tab bar). */
export function RoleSwitcher() {
  const pathname = usePathname();
  const { pending, error, switchTo } = useSwitch();
  const active = activePersona(pathname);
  return (
    <div data-demo-role-switcher className="fixed right-4 bottom-20 z-40 lg:bottom-4">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="border-demo/50 bg-bg-1 text-fg-1 hover:bg-bg-2">
            <Users aria-hidden="true" className="text-demo" />
            <span>Demo role</span>
            <span className="text-fg-2">{SWITCHER_PERSONAS.find((p) => p.key === active)?.label ?? 'Choose'}</span>
            <ChevronUp aria-hidden="true" className="text-fg-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" side="top" className="w-72 border-border-strong bg-bg-1 p-2">
          <p className="px-2 pt-1 pb-2 text-xs text-fg-2">Switch between seeded demo identities. Nothing here exists in LIVE mode.</p>
          <PersonaButtons onPick={(k) => void switchTo(k)} pending={pending} active={active} />
          <ErrorLine error={error} />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** The DEMO sign-in list on /login ("demo shows seeded identities only", 06-design §11.2.1). */
export function DemoPersonaList() {
  const { pending, error, switchTo } = useSwitch();
  return (
    <div data-demo-role-switcher className="flex flex-col gap-2">
      <PersonaButtons onPick={(k) => void switchTo(k)} pending={pending} active={null} large />
      <ErrorLine error={error} />
    </div>
  );
}
