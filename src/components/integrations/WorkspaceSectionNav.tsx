'use client';

/**
 * The sections of one assigned workspace (T28; 06-design §11.2 route map: lead console, Sheets,
 * Meta, extension hub, approvals, integrations, pipeline). Shown under the page header of the
 * workspace pages; the top bar's WorkspaceChip switches the workspace and keeps the section (it
 * rewrites the `[ws]` segment). The current section carries `aria-current="page"`. The row scrolls
 * inside itself on narrow screens, never the page, and scrolls the current section into view (each
 * page mounts the row at its start, so a section far along would otherwise be off-screen).
 */
import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { touchTarget } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { WORKSPACE_SECTIONS, workspaceSectionHref } from './sections';

export function WorkspaceSectionNav({ slug, workspaceName }: { slug: string; workspaceName: string }) {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navRef.current;
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !current) return;
    // Horizontal only (scrollIntoView could move the page): centre the current section in the row.
    nav.scrollLeft = Math.max(0, current.offsetLeft - (nav.clientWidth - current.offsetWidth) / 2);
  }, [pathname]);
  return (
    <nav ref={navRef} aria-label={`${workspaceName} sections`} className="-mx-1 overflow-x-auto px-1 pb-1">
      <ul className="flex w-max items-center gap-1 rounded-xl border border-border-subtle bg-bg-1/70 p-1">
        {WORKSPACE_SECTIONS.map((s) => {
          const href = workspaceSectionHref(slug, s.segment);
          const current = pathname === href || (pathname?.startsWith(`${href}/`) ?? false);
          const Icon = s.icon;
          return (
            <li key={s.segment}>
              <Link
                href={href}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'relative inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm whitespace-nowrap transition-colors duration-fast ease-enter',
                  current ? 'bg-panel/14 font-medium text-fg-1 ring-1 ring-panel/35 ring-inset' : 'text-fg-2 hover:bg-bg-3 hover:text-fg-1',
                  touchTarget,
                )}
              >
                <Icon aria-hidden="true" className={cn('size-4', current ? 'text-panel' : 'text-fg-3')} />
                {s.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
