'use client';

/**
 * DEMO role switcher (PRD "Role switcher", P19, ADR-04). Loaded ONLY through the build-time gate
 * in DemoChrome.tsx, so a LIVE build contains none of this module (tests/unit/arch/live-bundle).
 * It offers the fixed persona keys; the server maps a key to a seeded `isDemo` user and issues an
 * ordinary DEMO session (POST /api/demo/session, 404 in LIVE). No privilege is decided here.
 *
 * Look (design spec §6 "Auth"): each persona is a card in its panel's signature hue. Workspace
 * owner and Codecraft client (both Client panel) are aura, Employee (Operator panel) is zest and
 * Super admin (Platform admin) is flare. Each card has an icon chip and a corner wash, and lifts
 * on hover. The hue is orientation only; the label and hint name the persona. Each button's
 * accessible name starts with the persona label, since the icon is aria-hidden; tests and e2e use
 * /^Workspace owner/, which no other label starts with.
 *
 * The check mark follows the route: a panel only one persona lands on marks that persona; the
 * client panel, which both client personas share (ADR-126), marks none, because the route alone
 * cannot tell who is signed in; the trigger then names the panel ("Client panel"), not "Choose".
 *
 * The floating trigger is a solid pill. On panel routes below 1024px it sits above the bottom
 * tab bar and the iOS safe area. On /login it is not rendered, because the card there already
 * lists the same personas (with this module's marker). The popover is a dialog named by its
 * "Demo identities" heading.
 */
import { usePathname } from 'next/navigation';
import { useId, useState, type CSSProperties } from 'react';
import { ArrowRight, Building2, Check, ChevronUp, Globe, Headset, LoaderCircle, ShieldCheck, Users, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Stagger, StaggerItem } from '@/components/visual/Reveal';
import { isSafeRedirect, postJson } from './api-client';

/** Mirrors DEMO_PERSONAS in src/server/auth/demo-personas.ts (checked by live-bundle.test.ts). */
export const SWITCHER_PERSONAS = [
  { key: 'user', label: 'Workspace owner', home: '/dashboard/user', hint: 'Client panel' },
  { key: 'client', label: 'Codecraft client', home: '/dashboard/user', hint: 'Client panel, Codecraft Web Studio' },
  { key: 'employee', label: 'Employee', home: '/dashboard/employee', hint: 'Operator panel' },
  { key: 'admin', label: 'Super admin', home: '/dashboard/admin', hint: 'Platform panel' },
] as const;

type PersonaKey = (typeof SWITCHER_PERSONAS)[number]['key'];
type SwitchError = { message: string; reference: string | null };

/** Panel signature hue and icon per persona (Client = aura, Operator = zest, Platform admin = flare). */
const PERSONA_LOOK: Readonly<Record<PersonaKey, { icon: LucideIcon; hue: string }>> = {
  user: { icon: Building2, hue: 'var(--aura)' },
  client: { icon: Globe, hue: 'var(--aura)' },
  employee: { icon: Headset, hue: 'var(--zest)' },
  admin: { icon: ShieldCheck, hue: 'var(--flare)' },
};

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

function personasOn(pathname: string | null) {
  return SWITCHER_PERSONAS.filter((p) => pathname === p.home || pathname?.startsWith(`${p.home}/`));
}

function activePersona(pathname: string | null): PersonaKey | null {
  const hits = personasOn(pathname);
  // Two personas share the client panel: the route alone cannot say which one is signed in.
  return hits.length === 1 ? hits[0]!.key : null;
}

/** The trigger's label: the persona when the route names one, the shared panel when it names several. */
function triggerLabel(pathname: string | null): string {
  const hits = personasOn(pathname);
  if (hits.length === 1) return hits[0]!.label;
  // The first persona of a shared panel carries the bare panel name as its hint ("Client panel").
  return hits.length > 1 ? hits[0]!.hint : 'Choose';
}

function PersonaButton(props: { persona: (typeof SWITCHER_PERSONAS)[number]; onPick: (key: PersonaKey) => void; pending: PersonaKey | null; active: PersonaKey | null; large: boolean }) {
  const { persona: p, large } = props;
  const isActive = props.active === p.key;
  const isPending = props.pending === p.key;
  const look = PERSONA_LOOK[p.key];
  const Icon = look.icon;
  return (
    <button
      type="button"
      aria-current={isActive ? 'page' : undefined}
      aria-busy={isPending || undefined}
      onClick={() => props.onPick(p.key)}
      style={{ '--persona': look.hue } as CSSProperties}
      className={cn(
        'group relative isolate flex w-full items-center gap-3 overflow-hidden border text-left',
        'transition-[translate,border-color,background-color] duration-fast ease-enter',
        'before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:bg-[radial-gradient(120%_150%_at_0%_0%,color-mix(in_oklab,var(--persona)_20%,transparent),transparent_64%)] before:opacity-75 before:transition-opacity before:duration-fast hover:before:opacity-100',
        large
          ? 'min-h-16 rounded-xl border-(--persona)/22 bg-bg-2/80 px-3 py-2.5 hover:border-(--persona)/55 hover:bg-bg-2 motion-safe:hover:-translate-y-0.5'
          : 'min-h-12 rounded-lg border-transparent px-2 py-1.5 hover:border-(--persona)/35 hover:bg-bg-3/60',
        isActive && 'border-(--persona)/40 bg-(--persona)/8',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex shrink-0 items-center justify-center rounded-lg bg-(--persona)/14 text-(--persona) ring-1 ring-(--persona)/30 ring-inset transition-transform duration-fast ease-enter motion-safe:group-hover:scale-105',
          large ? 'size-11' : 'size-8',
        )}
      >
        <Icon className={large ? 'size-5' : 'size-4'} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn('truncate font-medium text-fg-1', large && 'text-md')}>{isPending ? `Opening ${p.label.toLowerCase()}...` : p.label}</span>
        <span className="truncate text-xs text-fg-2">{p.hint}</span>
      </span>
      {isPending ? (
        <LoaderCircle aria-hidden="true" className="size-4 shrink-0 text-(--persona) motion-safe:animate-spin" />
      ) : isActive ? (
        <Check aria-hidden="true" className="size-4 shrink-0 text-(--persona)" />
      ) : (
        <ArrowRight
          aria-hidden="true"
          className="size-4 shrink-0 text-fg-3 transition-[color,translate] duration-fast ease-enter group-hover:text-(--persona) motion-safe:group-hover:translate-x-0.5"
        />
      )}
    </button>
  );
}

function PersonaButtons(props: { onPick: (key: PersonaKey) => void; pending: PersonaKey | null; active: PersonaKey | null; large?: boolean }) {
  const large = Boolean(props.large);
  if (large) {
    // /login: the cards rise in one after another when the list mounts (static under reduced motion).
    return (
      <Stagger as="ul" step="list" delay={0} className="flex flex-col gap-2.5">
        {SWITCHER_PERSONAS.map((p) => (
          <StaggerItem key={p.key} as="li">
            <PersonaButton persona={p} onPick={props.onPick} pending={props.pending} active={props.active} large />
          </StaggerItem>
        ))}
      </Stagger>
    );
  }
  return (
    <ul className="flex flex-col gap-1">
      {SWITCHER_PERSONAS.map((p) => (
        <li key={p.key}>
          <PersonaButton persona={p} onPick={props.onPick} pending={props.pending} active={props.active} large={false} />
        </li>
      ))}
    </ul>
  );
}

function ErrorLine({ error }: { error: SwitchError | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="mt-2 rounded-md border border-danger/35 bg-danger/12 px-3 py-2 text-xs text-fg-1">
      {error.message}
      {error.reference ? <span className="block text-fg-2">Reference: {error.reference}</span> : null}
    </p>
  );
}

/** Floating DEMO control (bottom right; above the mobile tab bar on panel routes). Hidden on /login. */
export function RoleSwitcher() {
  const pathname = usePathname();
  const { pending, error, switchTo } = useSwitch();
  const titleId = useId();
  const active = activePersona(pathname);
  if (pathname === '/login') return null;
  const onPanel = pathname?.startsWith('/dashboard/') || pathname === '/dashboard';
  const activeLabel = triggerLabel(pathname);
  return (
    <div
      data-demo-role-switcher
      className={cn('fixed right-4 z-40', onPanel ? 'bottom-[calc(4.5rem+env(safe-area-inset-bottom))] lg:bottom-4' : 'bottom-4')}
    >
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="group h-9 gap-2 rounded-full border-demo/55 bg-bg-1 pr-2.5 pl-1.5 text-fg-1 shadow-overlay hover:border-demo/80 hover:bg-bg-2 data-[state=open]:border-demo/80 data-[state=open]:bg-bg-2"
          >
            <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-full bg-demo/18 ring-1 ring-demo/40 ring-inset">
              <Users className="size-3.5 text-demo" />
            </span>
            <span>Demo role</span>
            <span className="hidden max-w-36 truncate text-fg-2 sm:inline">{activeLabel}</span>
            <ChevronUp aria-hidden="true" className="text-fg-3 transition-transform duration-fast group-data-[state=open]:rotate-180" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" side="top" sideOffset={8} aria-labelledby={titleId} className="w-[min(20rem,calc(100vw-2rem))] p-2">
          <p id={titleId} className="flex items-center gap-2 px-2 pt-1 text-[11px] font-semibold tracking-[0.14em] text-fg-2 uppercase">
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-demo" />
            Demo identities
          </p>
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
