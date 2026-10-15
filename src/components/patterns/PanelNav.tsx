'use client';

/**
 * Panel navigation (06-design §11.2, §11.9): a 240px sidebar at 1024px and above; below that a
 * bottom tab bar with the primary sections plus a "More" sheet holding every section and the
 * account actions. Touch targets are at least 44px below 1024px. Active items carry
 * aria-current="page".
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogOut, Menu } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { isActive, PANELS, primaryTabs, type PanelKey } from './panel-nav';
import { useSignOut } from './UserMenu';

export function SidebarNav({ panel }: { panel: PanelKey }) {
  const pathname = usePathname();
  const definition = PANELS[panel];
  return (
    <nav aria-label={definition.title} className="flex flex-col gap-1 p-3">
      <p className="px-3 pt-1 pb-2 text-xs font-medium tracking-wide text-fg-3 uppercase">{definition.title}</p>
      {definition.items.map((item) => {
        const active = isActive(item, pathname);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex h-9 items-center gap-3 rounded-md px-3 text-fg-2 transition-colors duration-150 hover:bg-bg-2 hover:text-fg-1',
              active && 'bg-bg-3 text-fg-1',
            )}
          >
            <Icon aria-hidden="true" className={cn('size-4', active ? 'text-cyan' : 'text-fg-3')} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function BottomTabs({ panel }: { panel: PanelKey }) {
  const pathname = usePathname();
  const definition = PANELS[panel];
  const { pending, signOut } = useSignOut();
  return (
    <nav aria-label={`${definition.title} tabs`} className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-border-subtle bg-bg-1 lg:hidden">
      <ul className="mx-auto flex max-w-xl items-stretch justify-around">
        {primaryTabs(definition).map((item) => {
          const active = isActive(item, pathname);
          const Icon = item.icon;
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn('flex min-h-14 flex-col items-center justify-center gap-0.5 px-2 text-xs text-fg-2', active && 'text-fg-1')}
              >
                <Icon aria-hidden="true" className={cn('size-5', active ? 'text-cyan' : 'text-fg-3')} />
                <span className="truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
        <li className="flex-1">
          <Sheet>
            <SheetTrigger className="flex min-h-14 w-full flex-col items-center justify-center gap-0.5 px-2 text-xs text-fg-2">
              <Menu aria-hidden="true" className="size-5 text-fg-3" />
              More
            </SheetTrigger>
            <SheetContent side="bottom" className="rounded-t-xl border-border-strong bg-bg-1">
              <SheetHeader>
                <SheetTitle>{definition.title}</SheetTitle>
                <SheetDescription>Every section of this panel.</SheetDescription>
              </SheetHeader>
              <ul className="flex flex-col gap-1 px-4 pb-6">
                {definition.items.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item, pathname);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={cn('flex min-h-11 items-center gap-3 rounded-md px-3 text-fg-1 hover:bg-bg-2', active && 'bg-bg-3')}
                      >
                        <Icon aria-hidden="true" className="size-4 text-fg-3" />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
                <li>
                  <button
                    type="button"
                    onClick={() => void signOut()}
                    aria-busy={pending || undefined}
                    className="flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-fg-1 hover:bg-bg-2"
                  >
                    <LogOut aria-hidden="true" className="size-4 text-fg-3" />
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
