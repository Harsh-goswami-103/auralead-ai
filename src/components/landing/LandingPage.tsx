/**
 * The public landing page "/" (plan T30): glass nav, hero with the 3D core, integrations marquee,
 * how it works, feature bento, ROI estimate, principles, a closing CTA and the footer. One h1,
 * header / nav / main / footer landmarks, and a skip link to main as the first tab stop. The mode
 * only changes CTA labels and the DEMO notes (LIVE never mentions the demo, ADR-116); it is read on the server by the route. Server
 * component; the motion pieces are client islands.
 * In-page anchors glide (html scroll-behavior, set only while this page is mounted and only
 * without a reduced-motion preference).
 */
import { ModeBanner } from '@/components/patterns/ModeBanner';
import { ClosingCta } from './ClosingCta';
import type { LandingMode } from './cta';
import { FeatureBento } from './FeatureBento';
import { Hero } from './Hero';
import { HowItWorks } from './HowItWorks';
import { IntegrationsMarquee } from './IntegrationsMarquee';
import { LandingFooter } from './LandingFooter';
import { LandingNav } from './LandingNav';
import { RoiSection } from './RoiSection';
import { TruthStrip } from './TruthStrip';

export function LandingPage({ mode }: { mode: LandingMode }) {
  return (
    <div
      data-landing=""
      data-mode={mode}
      className="relative flex min-h-dvh flex-col overflow-x-clip bg-bg-0 motion-safe:[html:has(&)]:scroll-smooth"
    >
      {/* The first tab stop, as in PanelShell: past the six nav stops to the content (06-design §11.11). */}
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-primary font-medium text-primary-foreground shadow-overlay focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      {mode === 'demo' ? <ModeBanner mode="demo" /> : null}
      <LandingNav mode={mode} />
      <main id="main" className="flex-1 scroll-mt-16">
        <Hero mode={mode} />
        <IntegrationsMarquee />
        <HowItWorks mode={mode} />
        <FeatureBento mode={mode} />
        <RoiSection />
        <TruthStrip mode={mode} />
        <ClosingCta mode={mode} />
      </main>
      <LandingFooter mode={mode} />
    </div>
  );
}
