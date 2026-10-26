/**
 * One documentation page (plan T37): the PageHeader (eyebrow, the one h1, the summary, then
 * "Applies to" and the checked date), "On this page" (a link per section; from 1280 px a sticky
 * column beside the text, before that a list under the header), the sections as SectionCards whose
 * ids are the stable anchors, and previous / next links in sidebar order. Server-safe.
 */
import Link from 'next/link';
import { ArrowLeft, ArrowRight, ListTree } from 'lucide-react';
import type { DocPage } from '@content/docs/format';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { AppliesTo, CheckedDate } from './AppliesTo';
import { DocBlocks } from './DocBlocks';

type Neighbour = Pick<DocPage, 'slug' | 'title'> | undefined;

function OnThisPage({ page }: { page: DocPage }) {
  return (
    <nav aria-label="On this page" className="flex flex-col gap-2 rounded-xl border border-border-subtle bg-bg-1/60 p-4 xl:sticky xl:top-20 xl:max-h-[calc(100dvh-6rem)] xl:overflow-y-auto xl:border-0 xl:bg-transparent xl:p-0">
      <p className="flex items-center gap-2 text-xs font-medium tracking-[0.14em] text-fg-2 uppercase">
        <ListTree aria-hidden="true" className="size-3.5 shrink-0 text-panel" />
        On this page
      </p>
      <ol className="flex flex-col gap-0.5 text-sm">
        {page.sections.map((s) => (
          <li key={s.id}>
            <a href={`#${s.id}`} className="inline-flex min-h-9 items-center rounded-md py-1 text-fg-2 hover:text-aura xl:min-h-7">
              {s.title}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Pager({ previous, next }: { previous: Neighbour; next: Neighbour }) {
  if (!previous && !next) return null;
  const card = 'group flex min-h-16 min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-xl border border-border-subtle bg-bg-1/60 px-4 py-3 transition-colors duration-fast hover:border-aura/40 hover:bg-bg-2/70';
  return (
    <nav aria-label="Previous and next page" className="flex flex-col gap-3 sm:flex-row">
      {previous ? (
        <Link href={`/docs/${previous.slug}`} className={card}>
          <span className="flex items-center gap-1 text-xs text-fg-2">
            <ArrowLeft aria-hidden="true" className="size-3.5" />
            Previous
          </span>
          <span className="font-medium text-fg-1 group-hover:text-aura">{previous.title}</span>
        </Link>
      ) : (
        <span aria-hidden="true" className="hidden flex-1 sm:block" />
      )}
      {next ? (
        <Link href={`/docs/${next.slug}`} className={`${card} sm:items-end sm:text-right`}>
          <span className="flex items-center gap-1 text-xs text-fg-2">
            Next
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </span>
          <span className="font-medium text-fg-1 group-hover:text-aura">{next.title}</span>
        </Link>
      ) : null}
    </nav>
  );
}

/** `showModes`: the Applies to tags, shown only in DEMO (a LIVE process shows only LIVE content, ADR-116). */
export function DocArticle({ page, previous, next, showModes }: { page: DocPage; previous: Neighbour; next: Neighbour; showModes: boolean }) {
  return (
    <article data-doc-page={page.slug} className="flex min-w-0 flex-col gap-6 xl:grid xl:grid-cols-[minmax(0,1fr)_14rem] xl:items-start xl:gap-x-10">
      <PageHeader
        className="xl:col-start-1"
        eyebrow="Documentation"
        title={page.title}
        description={page.summary}
        meta={
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
            {showModes ? <AppliesTo modes={page.appliesTo} /> : null}
            <CheckedDate iso={page.checked} />
          </div>
        }
      />
      <div className="xl:col-start-2 xl:row-span-2 xl:row-start-1 xl:h-full">
        <OnThisPage page={page} />
      </div>
      <div className="flex min-w-0 flex-col gap-6 xl:col-start-1">
        {page.sections.map((s) => (
          <SectionCard key={s.id} id={s.id} title={s.title} meta={showModes && s.appliesTo ? <AppliesTo modes={s.appliesTo} /> : undefined} className="scroll-mt-20">
            <DocBlocks blocks={s.blocks} />
          </SectionCard>
        ))}
        <Pager previous={previous} next={next} />
      </div>
    </article>
  );
}
