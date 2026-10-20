/**
 * Branding, the Pricing area's quotation look (T27; PRD "Pricing (service CRUD, branding, ...)";
 * plan §9 P7, §10 F14): the workspace logo, the brand colour with the exact colours quotations
 * paint, and the GSTIN and terms printed on quotations. Read on the server through the
 * tenant-scoped context; changes go through /api/app/branding/* and the page re-reads the database.
 * Members see the same details read-only (permission gate); the owner edits them.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { PageHeader } from '@/components/patterns/PageHeader';
import { formatDateTime } from '@/lib/format/date';
import { getPageContext } from '@/server/auth/page-context';
import { getBranding, serializeBranding } from '@/server/services/pricing/branding';
import { BrandingWorkspace } from './branding-forms';

export const metadata: Metadata = { title: 'Branding' };
export const dynamic = 'force-dynamic';

export default async function BrandingPage() {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const branding = await getBranding(page.ctx);

  return (
    <div className="flex flex-col gap-6">
      <Link href="/dashboard/user/pricing" className="group inline-flex min-h-11 w-fit items-center gap-1 text-sm text-fg-2 hover:text-fg-1 lg:min-h-9">
        <ArrowLeft aria-hidden="true" className="size-4 transition-transform duration-fast motion-safe:group-hover:-translate-x-0.5" />
        Pricing
      </Link>
      <PageHeader
        eyebrow="Pricing"
        title="Branding"
        description="How your quotations look and what they print: logo, brand colour, GSTIN and terms. New quotation versions use these details; issued versions keep the ones they were issued with."
        meta={`Last changed ${formatDateTime(branding.updatedAt, branding.workspace.timezone)}`}
      />
      <BrandingWorkspace branding={serializeBranding(branding)} />
    </div>
  );
}
