/**
 * Landing footer: product mark and wordmark, the one-line description, in-page links, the
 * documentation link (/docs, T37) and the primary CTA again, under the same aurora hairline that
 * closes the nav. No social or legal stubs. Server-safe.
 */
import Link from 'next/link';
import { ProductMark } from '@/components/patterns/ProductMark';
import { PrimaryCta, type LandingMode } from './cta';
import { Wordmark } from './LandingNav';
import { LANDING_SECTIONS } from './sections';

export function LandingFooter({ mode }: { mode: LandingMode }) {
  return (
    <footer data-landing-footer="" className="relative bg-bg-1/60">
      <div aria-hidden="true" className="hairline-panel absolute inset-x-0 top-0" />
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-8 px-4 py-10 sm:px-6 lg:flex-row lg:items-start lg:justify-between lg:px-8">
        <div className="flex max-w-sm flex-col gap-3">
          <Link href="/" className="-ml-1 flex w-fit items-center gap-2.5 rounded-md px-1 py-1 max-lg:min-h-11">
            <ProductMark className="size-8 shrink-0" />
            <Wordmark />
          </Link>
          <p className="text-sm text-fg-2">Lead capture, scoring, versioned quotes and consent-aware messaging for Indian service businesses.</p>
          <p className="text-xs text-fg-3">{mode === 'demo' ? 'This instance runs in DEMO mode with simulated providers.' : 'This instance runs in LIVE mode.'}</p>
        </div>
        <nav aria-label="Footer" className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-12">
          <ul className="grid grid-cols-2 gap-x-8 gap-y-1 sm:grid-cols-1">
            {LANDING_SECTIONS.map((s) => (
              <li key={s.href}>
                <a href={s.href} className="inline-flex min-h-11 items-center rounded-md text-sm text-fg-2 hover:text-fg-1 lg:min-h-8">
                  {s.label}
                </a>
              </li>
            ))}
            <li>
              <Link href="/docs" className="inline-flex min-h-11 items-center rounded-md text-sm text-fg-2 hover:text-fg-1 lg:min-h-8">
                Documentation
              </Link>
            </li>
          </ul>
          <PrimaryCta mode={mode} size="default" className="w-full sm:w-auto" />
        </nav>
      </div>
    </footer>
  );
}
