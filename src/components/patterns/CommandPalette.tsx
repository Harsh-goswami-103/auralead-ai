'use client';

/**
 * Command palette (cmdk, 06-design §11.2 and §11.11; design spec §6): Ctrl/Cmd+K anywhere in a
 * panel. It lists the panel's real sections (the same PANELS entries as the nav, so it never
 * offers a route that does not exist) and sign out.
 *
 * The surface is glass with the panel hairline (ui/command). A faint static panel-hue wash sits
 * behind the search field, and the selected row gets the panel tint and a leading bar. The
 * trigger shows "⌘ K" on Apple platforms and "Ctrl K" elsewhere. That is read with
 * useSyncExternalStore and a server snapshot, so hydration always agrees. A footer lists the
 * keys at md and up, where a keyboard is likely. Sign out is tinted toward danger, as in the
 * account menu and the More sheet, since it ends the session.
 *
 * Closing returns focus to where it was when the palette opened (the trigger, or the element
 * that had focus when Ctrl/Cmd+K was pressed). The dialog has no Radix trigger, so Radix alone
 * would drop focus to <body>. After a jump to another section, focus goes to the trigger, which
 * stays in the top bar while the page changes.
 */
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { touchTarget } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { CornerDownLeft, LogOut, Search } from 'lucide-react';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { AuroraBackdrop } from '@/components/visual/AuroraBackdrop';
import { PANELS, type PanelKey } from './panel-nav';
import { useSignOut } from './UserMenu';

const noopSubscribe = () => () => undefined;

function useApplePlatform(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent),
    () => false,
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border-strong bg-bg-1 px-1 font-mono text-[11px] leading-none text-fg-2 shadow-[inset_0_-1px_0_var(--border-strong)]">
      {children}
    </kbd>
  );
}

/** The element that has focus now, if it is not just the page body. */
function focusedElement(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

export function CommandPalette({ panel }: { panel: PanelKey }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const router = useRouter();
  const { signOut } = useSignOut();
  const apple = useApplePlatform();
  const definition = PANELS[panel];

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        // Remember the focus only when opening: Ctrl/Cmd+K while open just closes the palette.
        if (!open) returnFocusRef.current = focusedElement();
        setOpen(!open);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  function go(href: string) {
    returnFocusRef.current = triggerRef.current;
    setOpen(false);
    router.push(href);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          returnFocusRef.current = triggerRef.current;
          setOpen(true);
        }}
        aria-keyshortcuts="Control+K Meta+K"
        className={cn(
          'group relative flex h-9 shrink-0 items-center gap-2 rounded-lg border border-border-subtle bg-bg-2/70 px-2.5 text-fg-2 transition-colors duration-fast ease-enter hover:border-panel/45 hover:bg-bg-3 hover:text-fg-1 md:pr-1.5 md:pl-3',
          touchTarget,
        )}
      >
        <Search aria-hidden="true" className="size-4 transition-colors duration-fast group-hover:text-panel" />
        <span className="hidden md:inline">Jump to</span>
        <span aria-hidden="true" className="hidden items-center gap-0.5 md:ml-3 md:inline-flex">
          <Kbd>{apple ? '⌘' : 'Ctrl'}</Kbd>
          <Kbd>K</Kbd>
        </span>
        <span className="sr-only md:hidden">Open command palette</span>
      </button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = returnFocusRef.current;
          returnFocusRef.current = null;
          (target?.isConnected ? target : triggerRef.current)?.focus();
        }}
        title="Command palette"
        description={`Jump to a section of the ${definition.title.toLowerCase()}`}
        className="isolate border-border-strong shadow-overlay"
      >
        <AuroraBackdrop variant="empty" grain={false} className="bottom-auto h-32" />
        <CommandInput placeholder="Type a section or command" />
        <CommandList className="max-h-[min(360px,60dvh)] pb-1">
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
              className="data-[selected=true]:bg-danger/12 data-[selected=true]:shadow-[inset_2px_0_0_var(--danger)]"
            >
              <LogOut aria-hidden="true" className="text-danger" />
              Sign out
            </CommandItem>
          </CommandGroup>
        </CommandList>
        <div aria-hidden="true" className="hidden items-center gap-4 border-t border-border-subtle px-4 py-2.5 text-[11px] text-fg-3 md:flex">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            to move
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>
              <CornerDownLeft className="size-3" />
            </Kbd>
            to open
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>Esc</Kbd>
            to close
          </span>
        </div>
      </CommandDialog>
    </>
  );
}
