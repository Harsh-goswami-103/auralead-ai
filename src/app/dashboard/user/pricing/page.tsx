/**
 * Client Pricing page (T13; 06-design §11 "User Pricing"): services with the active price list,
 * tax, discount limits, timelines and the read-only version history. Data is read on the server
 * through the tenant-scoped context; every change goes through /api/app/pricing/* route handlers
 * (ADR-26) and the page re-reads the database afterwards. Branding is added by T27. The header is
 * the shared PageHeader (aurora band, gradient h1).
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/patterns/PageHeader';
import { formatDate } from '@/lib/format/date';
import { getPageContext } from '@/server/auth/page-context';
import { getPricingOverview, serializeOverview } from '@/server/services/pricing/catalog';
import { PricingWorkspace } from './pricing-workspace';

export const metadata: Metadata = { title: 'Pricing' };
export const dynamic = 'force-dynamic';

export default async function UserPricingPage() {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const overview = await getPricingOverview(page.ctx);
  const tz = overview.workspace.timezone;
  const active = overview.activeVersion;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Pricing"
        title="Services and prices"
        description={
          <>
            {active ? `Price list v${active.version}, published ${formatDate(active.createdAt, tz)}. ` : 'No price list yet. '}
            Quotes take their prices from here. Issued quotes keep the prices they were issued with.
          </>
        }
      />
      <PricingWorkspace overview={serializeOverview(overview)} />
    </div>
  );
}
