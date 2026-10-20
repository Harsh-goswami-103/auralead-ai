'use client';

/**
 * Panel navigation (06-design §11.2, §11.9; design spec §6 "Shell"). At 1024px and above it is a
 * 240px sidebar. Below that it is a bottom tab bar with the primary sections plus a "More" sheet
 * holding every section and the account actions.
 *
 * The active item is marked by a pill in the panel hue at 14%, with a 2px leading bar and a
 * panel-hue icon. The pill slides between items with a Motion layoutId, and the bottom tabs use
 * a sliding top bar and icon pill. Every active item also carries aria-current="page" and a
 * shape cue, so the state is never color alone. MotionConfig reducedMotion="user" (Providers)
 * turns the slide into a jump.
 *
 * Touch targets are at least 44px below 1024px. Tabs share the width equally (min-w-0) and long
 * labels wrap to two lines instead of crowding their neighbours.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'motion/react';
import { ChevronRight, LogOut, Menu } from 'lucide-react';
import { spring } from '@/components/motion/presets';
import { cn } from '@/components/ui/cn';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { isActive, PANELS, primaryTabs, type PanelKey } from './panel-nav';
import { useSignOut } from './UserMenu';

export function SidebarNav({ panel }: { panel: PanelKey }) {
  const pathname = usePathname();
  const definition = PANELS[panel];
  return (
    <nav aria-label={definition.title} className="flex flex-col gap-1 px-3 pt-6 pb-3">
      <ul className="flex flex-col gap-0.5">
        {definition.items.map((item) => {
          const active = isActive(item, pathname);
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group relative flex h-10 items-center gap-3 rounded-lg px-3 text-fg-2 transition-colors duration-fast ease-enter',
                  active ? 'font-medium text-fg-1' : 'hover:bg-bg-2 hover:text-fg-1',
                )}
              >
                {active ? (
                  <motion.span
                    layoutId={`nav-pill-${panel}`}
                    transition={spring.smooth}
                    aria-hidden="true"
                    className="absolute inset-0 rounded-lg bg-panel/14 ring-1 ring-panel/20 ring-inset"
                  >
                    <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-panel" />
                  </motion.span>
                ) : null}
                <Icon
                  aria-hidden="true"
                  className={cn(
                    'relative size-4.5 shrink-0 transition-[color,translate] duration-fast ease-enter',
                    active ? 'text-panel' : 'text-fg-3 group-hover:text-fg-2 motion-safe:group-hover:translate-x-0.5',
                  )}
                />
                <span className="relative truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function BottomTabs({ panel }: { panel: PanelKey }) {
  const pathname = usePathname();
  const definition = PANELS[panel];
  const { pending, signOut } = useSignOut();
  return (
    <nav
      aria-label={`${definition.title} tabs`}
      className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-border-subtle bg-bg-1/90 backdrop-blur-md lg:hidden"
    >
      <span aria-hidden="true" className="hairline-panel absolute inset-x-0 -top-px opacity-70" />
      <ul className="mx-auto flex max-w-xl items-stretch">
        {primaryTabs(definition).map((item) => {
          const active = isActive(item, pathname);
          const Icon = item.icon;
          return (
            <li key={item.href} className="min-w-0 flex-1">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex min-h-15 w-full flex-col items-center justify-start gap-1 px-1 pt-2 pb-1.5 text-[11px] leading-[13px] font-medium text-fg-2 transition-colors duration-fast',
                  active && 'text-fg-1',
                )}
              >
                {active ? (
                  <motion.span
                    layoutId={`tab-bar-${panel}`}
                    transition={spring.smooth}
                    aria-hidden="true"
                    className="absolute inset-x-4 top-0 h-0.5 rounded-b-full bg-panel"
                  />
                ) : null}
                <span className="relative flex h-7 w-12 shrink-0 items-center justify-center">
                  {active ? (
                    <motion.span
                      layoutId={`tab-pill-${panel}`}
                      transition={spring.smooth}
                      aria-hidden="true"
                      className="absolute inset-0 rounded-full bg-panel/14 ring-1 ring-panel/20 ring-inset"
                    />
                  ) : null}
                  <Icon aria-hidden="true" className={cn('relative size-5', active ? 'text-panel' : 'text-fg-3')} />
                </span>
                <span className="line-clamp-2 max-w-full text-center break-words">{item.label}</span>
              </Link>
            </li>
          );
        })}
        <li className="min-w-0 flex-1">
          <Sheet>
            <SheetTrigger className="relative flex min-h-15 w-full flex-col items-center justify-start gap-1 px-1 pt-2 pb-1.5 text-[11px] leading-[13px] font-medium text-fg-2 transition-colors duration-fast hover:text-fg-1">
              <span className="flex h-7 w-12 shrink-0 items-center justify-center">
                <Menu aria-hidden="true" className="size-5 text-fg-3" />
              </span>
              More
            </SheetTrigger>
            <SheetContent side="bottom" className="rounded-t-2xl">
              <span aria-hidden="true" className="mx-auto -mb-2 mt-2 h-1.5 w-10 shrink-0 rounded-full bg-border-strong" />
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-panel" />
                  {definition.title}
                </SheetTitle>
                <SheetDescription>Every section of this panel.</SheetDescription>
              </SheetHeader>
              <ul className="flex flex-col gap-1 px-4 pb-2">
                {definition.items.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item, pathname);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'group relative flex min-h-12 items-center gap-3 rounded-xl px-2 text-fg-1 transition-colors duration-fast',
                          active ? 'bg-panel/12 ring-1 ring-panel/25 ring-inset' : 'hover:bg-bg-2',
                        )}
                      >
                        {active ? <span aria-hidden="true" className="absolute inset-y-3 left-0 w-0.5 rounded-full bg-panel" /> : null}
                        <span
                          aria-hidden="true"
                          className={cn(
                            'flex size-9 shrink-0 items-center justify-center rounded-lg border',
                            active ? 'border-panel/30 bg-panel/14 text-panel' : 'border-border-subtle bg-bg-2 text-fg-2',
                          )}
                        >
                          <Icon className="size-4.5" />
                        </span>
                        <span className={cn('flex-1 truncate', active && 'font-medium')}>{item.label}</span>
                        <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-fg-3 transition-transform duration-fast motion-safe:group-hover:translate-x-0.5" />
                      </Link>
                    </li>
                  );
                })}
                <li className="mt-2 border-t border-border-subtle pt-2">
                  <button
                    type="button"
                    onClick={() => void signOut()}
                    aria-busy={pending || undefined}
                    className="group flex min-h-12 w-full items-center gap-3 rounded-xl px-2 text-fg-1 transition-colors duration-fast hover:bg-danger/10"
                  >
                    <span
                      aria-hidden="true"
                      className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-bg-2 text-fg-2 transition-colors duration-fast group-hover:border-danger/35 group-hover:text-danger"
                    >
                      <LogOut className="size-4.5" />
                    </span>
                    {pending ? 'Signing out...' : 'Sign out'}
                  </button>
                </li>
              </ul>
            </SheetContent>
          </Sheet>
        </li>
      </ul>
    </nav>
  );
}
