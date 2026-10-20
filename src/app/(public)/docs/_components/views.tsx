/**
 * The two docs views the routes render (plan T37): the index (/docs) and one page (/docs/[slug]).
 * The route modules only read the mode and the slug; everything else is here, so the unit tests
 * render exactly what the routes return. An unknown slug is a 404 (notFound). Server-safe.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { DOC_PAGES, docNeighbours, getDocPage } from '@content/docs/index';
import type { LandingMode } from '@/components/landing/cta';
import { PageHeader } from '@/components/patterns/PageHeader';
import { AppliesTo, CheckedDate } from './AppliesTo';
import { DocArticle } from './DocArticle';
import { DocsShell } from './DocsShell';

export function DocsPageView({ mode, slug }: { mode: LandingMode; slug: string }) {
  const page = getDocPage(slug);
  if (!page) notFound();
  const { previous, next } = docNeighbours(page.slug);
  return (
    <DocsShell mode={mode} current={page.slug}>
      <DocArticle page={page} previous={previous} next={next} />
    </DocsShell>
  );
}

export function DocsIndexView({ mode }: { mode: LandingMode }) {
  return (
    <DocsShell mode={mode} current={null}>
      <div className="flex min-w-0 flex-col gap-6">
        <PageHeader
          eyebrow="AuraLead AI"
          title="Documentation"
          description={
            mode === 'demo'
              ? 'How to run the demo, how leads become quotes, the messaging rules, security, data handling and the known limits. This instance runs in DEMO mode: pages marked LIVE describe a real deployment.'
              : 'How to deploy and run AuraLead AI, how leads become quotes, the messaging rules, security, data handling and the known limits. Pages marked DEMO describe the local demo.'
          }
        />
        <ul className="grid gap-4 md:grid-cols-2">
          {DOC_PAGES.map((p) => (
            <li key={p.slug} className="group relative flex min-w-0 flex-col gap-3 rounded-xl border border-border-subtle bg-bg-1/80 p-4 transition-colors duration-fast focus-within:border-aura/40 hover:border-aura/40 sm:p-5">
              <h2 className="font-display text-lg font-semibold text-fg-1">
                <Link href={`/docs/${p.slug}`} className="inline-flex items-center gap-1.5 after:absolute after:inset-0 after:rounded-xl group-hover:text-aura">
                  {p.title}
                  <ArrowRight aria-hidden="true" className="size-4 shrink-0 transition-transform duration-fast motion-safe:group-hover:translate-x-0.5" />
                </Link>
              </h2>
              <p className="text-sm text-fg-2">{p.summary}</p>
              <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2">
                <AppliesTo modes={p.appliesTo} />
                <CheckedDate iso={p.checked} />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </DocsShell>
  );
}
