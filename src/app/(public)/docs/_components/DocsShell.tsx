/**
 * The public documentation shell (plan T37, design spec §4/§6 on the landing's patterns): a skip
 * link to #main as the first tab stop, the DEMO banner in DEMO, a glass top bar (product mark,
 * "Docs", and the mode-aware sign-in link the landing uses), the page list as a sticky sidebar
 * from 1024 px, the content, and a footer. No panel signature is set, so the default aurora hue
 * applies (tokens only). Below 1024 px the sidebar is not shown: the top bar's "Docs" link opens
 * the index and every page ends with previous / next links. Server-safe.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { BookOpen } from 'lucide-react';
import { DOC_PAGES } from '@content/docs/index';
import { PrimaryCta, type LandingMode } from '@/components/landing/cta';
import { Wordmark } from '@/components/landing/LandingNav';
import { ModeBanner } from '@/components/patterns/ModeBanner';
import { ProductMark } from '@/components/patterns/ProductMark';
import { cn } from '@/components/ui/cn';

/** null on the index, the page slug elsewhere. */
export type DocsLocation = string | null;

function DocsHeader({ mode, current }: { mode: LandingMode; current: DocsLocation }) {
  return (
    <header data-docs-header="" className="sticky top-0 z-40">
      <div className="surface-glass border-b border-border-subtle">
        <nav aria-label="Main" className="mx-auto flex h-14 w-full max-w-[1280px] items-center gap-2 px-4 sm:gap-3 sm:px-6 lg:px-8">
          <Link href="/" className="-ml-1 flex shrink-0 items-center gap-2.5 rounded-md px-1 py-1 max-lg:min-h-11">
            <ProductMark className="size-8 shrink-0" />
            <span className="max-sm:sr-only">
              <Wordmark />
            </span>
          </Link>
          <span aria-hidden="true" className="h-5 w-px bg-border-strong" />
          <Link
            href="/docs"
            aria-current={current === null ? 'page' : undefined}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-fg-1 hover:text-aura lg:min-h-9"
          >
            <BookOpen aria-hidden="true" className="size-4 shrink-0 text-panel" />
            Docs
          </Link>
          <div className="ml-auto flex items-center gap-2">
            <PrimaryCta mode={mode} size="sm" />
          </div>
        </nav>
        <div aria-hidden="true" className="hairline-panel" />
      </div>
    </header>
  );
}

export function DocsSidebar({ current }: { current: DocsLocation }) {
  const item = (href: string, label: string, active: boolean) => (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex min-h-9 items-center rounded-md px-3 py-1.5 text-sm transition-colors duration-fast ease-enter',
        active ? 'bg-panel/10 font-medium text-fg-1' : 'text-fg-2 hover:bg-bg-2/70 hover:text-fg-1',
      )}
    >
      {active ? <span aria-hidden="true" className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-panel" /> : null}
      {label}
    </Link>
  );
  return (
    <nav aria-label="Documentation" className="sticky top-20 flex max-h-[calc(100dvh-6rem)] flex-col gap-1 overflow-y-auto pb-6">
      <p className="px-3 pb-1 text-xs font-medium tracking-[0.14em] text-fg-2 uppercase">Documentation</p>
      <ul className="flex flex-col gap-0.5">
        <li>{item('/docs', 'Overview', current === null)}</li>
        {DOC_PAGES.map((p) => (
          <li key={p.slug}>{item(`/docs/${p.slug}`, p.title, current === p.slug)}</li>
        ))}
      </ul>
    </nav>
  );
}

function DocsFooter({ mode }: { mode: LandingMode }) {
  return (
    <footer className="relative mt-8 bg-bg-1/60">
      <div aria-hidden="true" className="hairline-panel absolute inset-x-0 top-0" />
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-4 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
        <p className="max-w-prose text-sm text-fg-2">
          {mode === 'demo' ? 'This instance runs in DEMO mode with simulated providers.' : 'This instance runs in LIVE mode.'} Each page says which mode it applies to and
          when it was last checked against the code.
        </p>
        <nav aria-label="Footer">
          <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
            <li>
              <Link href="/" className="inline-flex min-h-11 items-center text-fg-2 hover:text-fg-1 lg:min-h-8">
                Home
              </Link>
            </li>
            <li>
              <Link href="/docs" className="inline-flex min-h-11 items-center text-fg-2 hover:text-fg-1 lg:min-h-8">
                All documentation
              </Link>
            </li>
            <li>
              <Link href="/login" className="inline-flex min-h-11 items-center text-fg-2 hover:text-fg-1 lg:min-h-8">
                {mode === 'demo' ? 'Open the demo' : 'Sign in'}
              </Link>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}

export function DocsShell({ mode, current, children }: { mode: LandingMode; current: DocsLocation; children: ReactNode }) {
  return (
    <div data-docs="" data-mode={mode} className="relative flex min-h-dvh flex-col overflow-x-clip bg-bg-0">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-primary font-medium text-primary-foreground shadow-overlay focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      {mode === 'demo' ? <ModeBanner mode="demo" /> : null}
      <DocsHeader mode={mode} current={current} />
      <div className="mx-auto flex w-full max-w-[1280px] flex-1 gap-8 px-4 pt-6 pb-4 sm:px-6 sm:pt-8 lg:px-8">
        <aside className="hidden w-60 shrink-0 lg:block">
          <DocsSidebar current={current} />
        </aside>
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 scroll-mt-20 focus:outline-none">
          {children}
        </main>
      </div>
      <DocsFooter mode={mode} />
    </div>
  );
}
