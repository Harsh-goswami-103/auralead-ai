/**
 * Client Pricing page (T13; 06-design §11 "User Pricing"): services with the active price list,
 * tax, discount limits, timelines and the read-only version history. Data is read on the server
 * through the tenant-scoped context; every change goes through /api/app/pricing/* route handlers
 * (ADR-26) and the page re-reads the database afterwards. Branding is added by T27.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
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
      <header className="flex flex-col gap-1">
        <p className="text-sm text-fg-2">Pricing</p>
        <h1 className="font-display text-2xl font-semibold text-fg-1 sm:text-3xl">Services and prices</h1>
        <p className="max-w-prose text-fg-2">
          {active ? `Price list v${active.version}, published ${formatDate(active.createdAt, tz)}. ` : 'No price list yet. '}
          Quotes take their prices from here. Issued quotes keep the prices they were issued with.
        </p>
      </header>
      <PricingWorkspace overview={serializeOverview(overview)} />
    </div>
  );
}
