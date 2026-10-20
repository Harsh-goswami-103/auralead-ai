/**
 * The ROI section (plan T30): heading plus the calculator island, which rises in once when it
 * scrolls into view (the figures inside render their final values; nothing counts up). Server-safe
 * wrapper.
 */
import { Reveal } from '@/components/visual/Reveal';
import { RoiCalculator } from './RoiCalculator';
import { SectionIntro } from './SectionIntro';

export function RoiSection() {
  return (
    <section id="roi" aria-labelledby="roi-title" data-landing-section="roi" className="relative isolate scroll-mt-20 pt-10 pb-20 sm:pt-12 sm:pb-24">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-10 px-4 sm:px-6 lg:px-8">
        <SectionIntro
          id="roi-title"
          accent="volt"
          eyebrow="ROI estimate"
          title="Put your own numbers in"
          description="A back-of-the-envelope estimate from assumptions you can see and change. Nothing here is a measured result."
        />
        <Reveal inView delay={0.08}>
          <RoiCalculator />
        </Reveal>
      </div>
    </section>
  );
}
