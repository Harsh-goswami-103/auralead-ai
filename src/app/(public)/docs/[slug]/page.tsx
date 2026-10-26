import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getDocPage } from '@content/docs/index';
import { getConfig } from '@/lib/config';
import { docModeOf } from '../_components/DocsShell';
import { DocsPageView } from '../_components/views';

/* Public (no session). Dynamic: the mode picks the banner, the labels and the pages it shows, and the CSP nonce needs a per-request render (ADR-69). */
export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = getDocPage((await params).slug, docModeOf(getConfig().mode));
  return page ? { title: `${page.title} (docs)`, description: page.summary } : {};
}

/** One documentation page (plan T37); an unknown slug, or one for the other mode (ADR-116), is a 404. */
export default async function DocPageRoute({ params }: Props) {
  const { slug } = await params;
  const mode = getConfig().mode;
  if (!getDocPage(slug, docModeOf(mode))) notFound();
  return <DocsPageView mode={mode} slug={slug} />;
}
