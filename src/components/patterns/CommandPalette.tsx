'use client';

/**
 * Command palette (cmdk, 06-design §11.2 and §11.11): Ctrl/Cmd+K anywhere in a panel. It lists
 * the panel's real sections (the same PANELS entries as the nav, so it never offers a route that
 * does not exist) and sign out. Glass surface is allowed here (F15).
 */
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LogOut, Search } from 'lucide-react';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command';
import { PANELS, type PanelKey } from './panel-nav';
import { useSignOut } from './UserMenu';

export function CommandPalette({ panel }: { panel: PanelKey }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { signOut } = useSignOut();
  const definition = PANELS[panel];

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-keyshortcuts="Control+K Meta+K"
        className="flex h-9 items-center gap-2 rounded-md border border-border-subtle bg-bg-2 px-3 text-fg-2 transition-colors duration-150 hover:bg-bg-3 hover:text-fg-1"
      >
        <Search aria-hidden="true" className="size-4" />
        <span className="hidden md:inline">Jump to</span>
        <kbd className="hidden rounded-xs border border-border-strong px-1 font-mono text-[11px] text-fg-3 md:inline">Ctrl K</kbd>
        <span className="sr-only md:hidden">Open command palette</span>
      </button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Command palette"
        description={`Jump to a section of the ${definition.title.toLowerCase()}`}
        className="surface-glass border-border-strong shadow-overlay"
      >
        <CommandInput placeholder="Type a section or command" />
        <CommandList>
          <CommandEmpty>No matching section.</CommandEmpty>
          <CommandGroup heading={definition.title}>
            {definition.items.map((item) => {
              const Icon = item.icon;
              return (
                <CommandItem key={item.href} value={`${item.label} ${item.href}`} onSelect={() => go(item.href)}>
                  <Icon aria-hidden="true" />
                  {item.label}
                </CommandItem>
              );
            })}
          </CommandGroup>
          <CommandGroup heading="Account">
            <CommandItem
              value="Sign out"
              onSelect={() => {
                setOpen(false);
                void signOut();
              }}
            >
              <LogOut aria-hidden="true" />
              Sign out
              <CommandShortcut>session</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
