/**
 * Landing top bar (plan T30, 06-design F15): the glass nav is one of the few places glass is
 * allowed (alpha >= .78 with a solid fallback, surface-glass). Product mark + wordmark, in-page
 * anchors (md and up; the page is one scroll on phones) with a scroll-spy pill (a small client
 * island) and the primary CTA, which stays visible at every width. A 1px aurora hairline closes
 * the bar. Server-safe.
 */
import Link from 'next/link';
import { ProductMark } from '@/components/patterns/ProductMark';
import { PrimaryCta, type LandingMode } from './cta';
import { LandingNavLinks } from './LandingNavLinks';

export { LANDING_SECTIONS } from './sections';

export function Wordmark() {
  return (
    <span className="font-display text-[17px] font-semibold tracking-tight text-fg-1">
      AuraLead <span className="text-aura">AI</span>
    </span>
  );
}

export function LandingNav({ mode }: { mode: LandingMode }) {
  return (
    <header data-landing-nav="" className="sticky top-0 z-40">
      <div className="surface-glass border-b border-border-subtle">
        <nav aria-label="Main" className="mx-auto flex h-16 w-full max-w-[1280px] items-center gap-3 px-4 sm:px-6 lg:px-8">
          <Link href="/" className="-ml-1 flex shrink-0 items-center gap-2.5 rounded-md px-1 py-1">
            <ProductMark className="size-8 shrink-0" />
            <Wordmark />
          </Link>
          <LandingNavLinks />
          <div className="ml-auto flex items-center gap-2">
            <PrimaryCta mode={mode} size="sm" />
          </div>
        </nav>
        <div aria-hidden="true" className="hairline-panel" />
      </div>
    </header>
  );
}
